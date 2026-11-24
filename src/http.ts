import { config } from "./config";
import { docsPage, REPO_URL } from "./docs";
import { SUPPORTED_RECORD_VERSIONS } from "./dns";
import { indexStatus, publicIndex, registerDnsIndex, unregisterDnsIndex } from "./indexes";
import { getSigningKey } from "./sign";
import { claimSubmission } from "./work";
import { errorResponse, HttpError, isRecord, json, log, errMessage } from "./util";
import { normalizeDomain, normalizeServerUrl } from "./validate";
import { MODERN_PROTOCOL_VERSION } from "./mcp";
import type { EventSource, ServerRow, WorkMessage } from "./types";

const HISTORY_NOTE =
  "This is MCPNow's history of MCP server URLs it has been given. It is not a definitive or current list of " +
  "working MCP servers: entries may be offline, moved, or no longer MCP servers. `last_status` is only what we " +
  "observed at `last_probed_at`.";

async function rateLimit(limiter: RateLimit, req: Request, bucket: string): Promise<void> {
  const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
  if (!success) throw new HttpError(429, "rate limited, slow down");
}

// --------------------------------------------------------------------------- /index

interface Submission {
  urls: string[];
  domains: string[];
}

async function readSubmission(req: Request, url: URL): Promise<Submission> {
  const sub: Submission = { urls: [], domains: [] };
  // Accept `url` and the `URL` spelling.
  for (const k of ["url", "URL"]) sub.urls.push(...url.searchParams.getAll(k));
  sub.domains.push(...url.searchParams.getAll("domain"));
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) throw new HttpError(400, "body must be a JSON object");
      if (Array.isArray(body.urls)) sub.urls.push(...body.urls.filter((u): u is string => typeof u === "string"));
      if (typeof body.url === "string") sub.urls.push(body.url);
      if (Array.isArray(body.domains)) sub.domains.push(...body.domains.filter((d): d is string => typeof d === "string"));
    } else if (ct.includes("form")) {
      const form = await req.formData();
      for (const v of form.getAll("url")) if (typeof v === "string") sub.urls.push(v);
      for (const v of form.getAll("domain")) if (typeof v === "string") sub.domains.push(v);
    }
  }
  if (sub.urls.length + sub.domains.length === 0) throw new HttpError(400, "provide ?url=<mcp server url> or ?domain=<domain>");
  if (sub.urls.length + sub.domains.length > 100) throw new HttpError(413, "at most 100 urls/domains per request");
  return sub;
}

async function handleSubmit(req: Request, env: Env, url: URL): Promise<Response> {
  await rateLimit(env.SUBMIT_LIMITER, req, "submit");
  const cfg = config(env);
  const sub = await readSubmission(req, url);
  const source: EventSource = { kind: "http", submitted_at: new Date().toISOString() };
  const results: Array<{ input: string; status: "queued" | "duplicate" | "rejected"; url?: string; domain?: string; error?: string }> = [];
  const messages: WorkMessage[] = [];

  for (const raw of sub.urls) {
    const n = normalizeServerUrl(raw, { allowInsecure: cfg.allowInsecure });
    if (!n.ok) {
      results.push({ input: raw, status: "rejected", error: n.error });
      continue;
    }
    if (await claimSubmission(env, n.value)) {
      messages.push({ kind: "probe", url: n.value, source });
      results.push({ input: raw, status: "queued", url: n.value });
    } else {
      results.push({ input: raw, status: "duplicate", url: n.value });
    }
  }
  for (const raw of sub.domains) {
    const d = normalizeDomain(raw);
    if (!d.ok) results.push({ input: raw, status: "rejected", error: d.error });
    else {
      messages.push({ kind: "discover_domain", domain: d.value, source });
      results.push({ input: raw, status: "queued", domain: d.value });
    }
  }
  if (messages.length) await env.WORK_QUEUE.sendBatch(messages.map((body) => ({ body })));

  const anyAccepted = results.some((r) => r.status !== "rejected");
  return json({ results }, anyAccepted ? 202 : 422);
}

// --------------------------------------------------------------------------- reads

async function handleEvents(env: Env, url: URL): Promise<Response> {
  const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const server = url.searchParams.get("url");
  const stmt = server
    ? env.DB.prepare("SELECT seq, payload FROM events WHERE server_url = ? AND seq > ? ORDER BY seq LIMIT ?").bind(server, after, limit)
    : env.DB.prepare("SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?").bind(after, limit);
  const { results } = await stmt.all<{ seq: number; payload: string }>();
  const events = results.map((r) => ({ ...JSON.parse(r.payload), seq: r.seq }));
  return json({ events, next_after: results.at(-1)?.seq ?? after, has_more: results.length === limit });
}

function serverSummary(r: ServerRow) {
  const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);
  return {
    url: r.url,
    first_seen_at: iso(r.first_seen_at),
    last_status: r.status,
    last_probed_at: iso(r.last_probed_at),
    last_ok_at: iso(r.last_ok_at),
  };
}

async function handleServers(env: Env, url: URL): Promise<Response> {
  const after = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200));
  const includeAll = url.searchParams.get("include") === "all";
  const { results } = await env.DB.prepare(
    `SELECT rowid AS cursor, url, first_seen_at, status, last_probed_at, last_ok_at FROM servers
     WHERE rowid > ? ${includeAll ? "" : "AND last_ok_at IS NOT NULL"} ORDER BY rowid LIMIT ?`,
  )
    .bind(after, limit)
    .all<ServerRow & { cursor: number }>();
  return json(
    {
      note: HISTORY_NOTE,
      filter: includeAll ? "all submitted URLs" : "URLs that answered as an MCP server at least once (use ?include=all for every submission)",
      servers: results.map(serverSummary),
      next_after: results.at(-1)?.cursor ?? after,
      has_more: results.length === limit,
    },
    200,
    { "cache-control": "public, max-age=300" },
  );
}

async function handleServer(env: Env, url: URL): Promise<Response> {
  const raw = url.searchParams.get("url");
  if (!raw) throw new HttpError(400, "provide ?url=");
  const n = normalizeServerUrl(raw, { allowInsecure: config(env).allowInsecure });
  const row = await env.DB.prepare("SELECT * FROM servers WHERE url = ?").bind(n.ok ? n.value : raw).first<ServerRow>();
  if (!row) throw new HttpError(404, "never seen this server");
  return json({ note: HISTORY_NOTE, ...serverSummary(row), last_error: row.last_error, info: row.info ? JSON.parse(row.info) : null });
}

async function handleWellKnown(env: Env): Promise<Response> {
  const cfg = config(env);
  const sk = await getSigningKey(env);
  return json(
    {
      name: "MCPNow",
      source: REPO_URL,
      license: "MIT",
      record_versions: SUPPORTED_RECORD_VERSIONS,
      mcp_protocol_version: MODERN_PROTOCOL_VERSION,
      endpoints: {
        submit: `${cfg.publicUrl}/index`,
        register_index: `${cfg.publicUrl}/register_index`,
        unregister_index: `${cfg.publicUrl}/unregister_index`,
        index_status: `${cfg.publicUrl}/index_status`,
        events: `${cfg.publicUrl}/events`,
        servers: `${cfg.publicUrl}/servers`,
        server: `${cfg.publicUrl}/server`,
      },
      dns_auth_record: { name: "<key>._authkey.<domain>", type: "TXT", value: "v=1; mcpnow=<https endpoint>" },
      atproto: {
        server_collection: cfg.serverCollection,
        index_collection: cfg.indexCollection,
      },
      server_card: { provider_meta_key: cfg.providerMetaKey },
      signing: {
        algorithm: "Ed25519",
        signed_payload: "<MCPNow-Timestamp>.<raw body>",
        headers: ["MCPNow-Timestamp", "MCPNow-Signature"],
        keys: sk ? [sk.publicJwk] : [],
      },
    },
    200,
    { "cache-control": "public, max-age=3600" },
  );
}

// --------------------------------------------------------------------------- router

export async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }
  try {
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
    switch (route) {
      case "GET /":
        return docsPage(env, req);
      case "GET /.well-known/mcpnow.json":
        return await handleWellKnown(env);
      case "GET /index":
      case "POST /index":
        return await handleSubmit(req, env, url);
      case "GET /register_index":
      case "POST /register_index": {
        await rateLimit(env.REGISTER_LIMITER, req, "register");
        const row = await registerDnsIndex(env, url.searchParams.get("domain"), url.searchParams.get("key"));
        return json({ index: publicIndex(row) });
      }
      case "GET /unregister_index":
      case "POST /unregister_index": {
        await rateLimit(env.REGISTER_LIMITER, req, "register");
        const row = await unregisterDnsIndex(env, url.searchParams.get("domain"), url.searchParams.get("key"));
        return json({ index: publicIndex(row) });
      }
      case "GET /index_status":
        return json({ index: publicIndex(await indexStatus(env, url.searchParams.get("domain"), url.searchParams.get("key"))) });
      case "GET /events":
        return await handleEvents(env, url);
      case "GET /servers":
        return await handleServers(env, url);
      case "GET /server":
        return await handleServer(env, url);
      default:
        return errorResponse(404, "not found");
    }
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.status, e.message, e.detail);
    log("error", "unhandled request error", { path: url.pathname, error: errMessage(e) });
    return errorResponse(500, "internal error");
  }
}
