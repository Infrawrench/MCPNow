/** Consumer for the `mcpnow-work` queue: probing, domain discovery, atproto commits, re-verification. */
import { config } from "./config";
import { assembleProbeResult, discoverDomainServers } from "./discovery";
import { makeEvent, publishEvent } from "./events";
import { revokeAtprotoIndex, reverifyIndex, upsertAtprotoIndex } from "./indexes";
import { AuthRequiredError, probeMcp } from "./mcp";
import { verifyIdentity } from "./atproto";
import { errMessage, isRecord, log, nowSec, sha256Hex, stableStringify } from "./util";
import { hostIsWithin, isBareOrigin, normalizeServerUrl } from "./validate";
import type { EventSource, ProbeResult, ServerRow, WorkMessage } from "./types";

const PROBE_ATTEMPTS = 3;
const PROBE_TIMEOUT_MS = 45_000;

type Outcome = "done" | { retryAfter: number };

// ------------------------------------------------------------------------- submissions

/**
 * Record a submission and decide whether it should be probed.
 * Returns false if the same URL was already submitted inside the dedupe window.
 */
export async function claimSubmission(env: Env, url: string): Promise<boolean> {
  const now = nowSec();
  const row = await env.DB.prepare(
    `INSERT INTO servers (url, first_seen_at, status, last_submitted_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(url) DO UPDATE SET last_submitted_at = excluded.last_submitted_at
     WHERE servers.last_submitted_at IS NULL OR servers.last_submitted_at < ?
     RETURNING url`,
  )
    .bind(url, now, now, now - config(env).dedupeSeconds)
    .first();
  return row !== null;
}

// ------------------------------------------------------------------------------- probe

/** Hash only the parts of a probe that describe the server, not when we looked. */
async function hashResult(r: ProbeResult): Promise<string> {
  const { probed_at: _p, ...rest } = r;
  return sha256Hex(stableStringify(rest));
}

async function markUnreachable(env: Env, url: string, error: string, source: EventSource): Promise<void> {
  const prev = await env.DB.prepare("SELECT status, last_ok_at FROM servers WHERE url = ?").bind(url).first<Pick<ServerRow, "status" | "last_ok_at">>();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO servers (url, first_seen_at, status, last_probed_at, last_error) VALUES (?, ?, 'unreachable', ?, ?)
     ON CONFLICT(url) DO UPDATE SET status = 'unreachable', last_probed_at = excluded.last_probed_at, last_error = excluded.last_error`,
  )
    .bind(url, now, now, error.slice(0, 1000))
    .run();
  // Only tell indexes about a transition from a known-good state.
  if (prev && (prev.status === "ok" || prev.status === "auth_required")) {
    const lastOk = prev.last_ok_at ? new Date(prev.last_ok_at * 1000).toISOString() : null;
    await publishEvent(env, makeEvent("mcp.server.unreachable", source, { url, error, last_ok_at: lastOk }), url);
  }
}

export async function handleProbe(env: Env, url: string, source: EventSource, attempt: number): Promise<Outcome> {
  const cfg = config(env);
  const policy = { allowInsecure: cfg.allowInsecure };

  // A bare origin ("https://example.com") means "discover what this site offers".
  if (isBareOrigin(url) && source.kind !== "catalog") {
    const found = await discoverDomainServers(new URL(url).host, { userAgent: cfg.userAgent, signal: AbortSignal.timeout(20_000) }, policy);
    if (found && found.urls.length > 0) {
      await enqueueCatalogUrls(env, new URL(url).host, found.catalogUrl, found.urls);
      // The origin itself wasn't an MCP server; don't keep it in the history as one.
      await env.DB.prepare("DELETE FROM servers WHERE url = ? AND status = 'pending'").bind(url).run();
      return "done";
    }
  }

  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const ctx = { userAgent: cfg.userAgent, signal, providerMetaKey: cfg.providerMetaKey };
  let result: ProbeResult;
  try {
    try {
      result = await assembleProbeResult(url, await probeMcp(url, ctx), ctx);
    } catch (e) {
      if (!(e instanceof AuthRequiredError)) throw e;
      result = await assembleProbeResult(url, { authRequired: e.wwwAuthenticate }, ctx);
    }
  } catch (e) {
    const error = errMessage(e);
    if (attempt < PROBE_ATTEMPTS) {
      log("info", "probe failed, will retry", { url, attempt, error });
      return { retryAfter: 60 * attempt * attempt };
    }
    log("warn", "probe failed permanently", { url, error });
    await markUnreachable(env, url, error, source);
    return "done";
  }

  const hash = await hashResult(result);
  const prev = await env.DB.prepare("SELECT status, info_hash FROM servers WHERE url = ?").bind(url).first<Pick<ServerRow, "status" | "info_hash">>();
  const changed = prev?.info_hash !== hash;
  const now = nowSec();

  await env.DB.prepare(
    `INSERT INTO servers (url, first_seen_at, status, last_probed_at, last_ok_at, info_hash, info, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(url) DO UPDATE SET status = excluded.status, last_probed_at = excluded.last_probed_at,
       last_ok_at = excluded.last_ok_at, info_hash = excluded.info_hash, info = excluded.info, last_error = NULL`,
  )
    .bind(url, now, result.status, now, now, hash, JSON.stringify(result))
    .run();

  // Recrawls only matter when something changed. Explicit pings are always forwarded.
  if (source.kind === "recrawl" && !changed) return "done";

  const previous_status = prev?.status && prev.status !== "pending" ? prev.status : null;
  await publishEvent(env, makeEvent("mcp.server.updated", source, { ...result, changed, previous_status }), url);
  return "done";
}

async function enqueueCatalogUrls(env: Env, domain: string, catalogUrl: string, urls: string[]): Promise<void> {
  const fresh: string[] = [];
  for (const u of urls) if (await claimSubmission(env, u)) fresh.push(u);
  const source: EventSource = { kind: "catalog", domain, catalog_url: catalogUrl };
  for (let i = 0; i < fresh.length; i += 100) {
    await env.WORK_QUEUE.sendBatch(fresh.slice(i, i + 100).map((url) => ({ body: { kind: "probe", url, source } satisfies WorkMessage })));
  }
  log("info", "catalog expanded", { domain, found: urls.length, enqueued: fresh.length });
}

// ----------------------------------------------------------------------------- atproto

interface RecordRow {
  cid: string | null;
  value: string | null;
  domain_verified: number;
}

async function handleAtprotoCommit(env: Env, msg: Extract<WorkMessage, { kind: "atproto_commit" }>, attempt: number): Promise<Outcome> {
  const cfg = config(env);
  const prev = await env.DB.prepare("SELECT cid, value, domain_verified FROM atproto_records WHERE did = ? AND collection = ? AND rkey = ?")
    .bind(msg.did, msg.collection, msg.rkey)
    .first<RecordRow>();
  if (msg.operation !== "delete" && prev && msg.cid && prev.cid === msg.cid) return "done"; // replayed from cursor

  const saveRecord = (value: string | null, verified: boolean) =>
    env.DB.prepare(
      `INSERT INTO atproto_records (did, collection, rkey, cid, value, domain_verified, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(did, collection, rkey) DO UPDATE SET cid = excluded.cid, value = excluded.value,
         domain_verified = excluded.domain_verified, updated_at = excluded.updated_at`,
    )
      .bind(msg.did, msg.collection, msg.rkey, msg.cid, value, verified ? 1 : 0, nowSec())
      .run();
  const deleteRecord = () =>
    env.DB.prepare("DELETE FROM atproto_records WHERE did = ? AND collection = ? AND rkey = ?").bind(msg.did, msg.collection, msg.rkey).run();
  const uri = `at://${msg.did}/${msg.collection}/${msg.rkey}`;

  // ---- index records
  if (msg.collection === cfg.indexCollection) {
    if (msg.operation === "delete") {
      await revokeAtprotoIndex(env, msg.did, msg.rkey);
      await deleteRecord();
      return "done";
    }
    try {
      const r = await upsertAtprotoIndex(env, msg.did, msg.rkey, msg.record);
      const endpoint = isRecord(msg.record) && typeof msg.record.endpoint === "string" ? msg.record.endpoint : null;
      await saveRecord(endpoint, r === "registered");
      return "done";
    } catch (e) {
      if (attempt < 5) return { retryAfter: 120 * attempt };
      log("warn", "atproto index registration gave up", { uri, error: errMessage(e) });
      return "done";
    }
  }

  // ---- server records
  if (msg.collection !== cfg.serverCollection) return "done";

  const removed = async (url: string, reason: "atproto_record_deleted" | "atproto_record_changed") => {
    const ident = await verifyIdentity(msg.did);
    const source: EventSource = { kind: "atproto", did: msg.did, handle: ident.handle, uri, cid: msg.cid, domain_verified: true };
    await publishEvent(env, makeEvent("mcp.server.removed", source, { url, reason }), url);
  };

  if (msg.operation === "delete") {
    // Only a domain-verified publisher may signal removal; anyone else's record just disappears.
    if (prev?.value && prev.domain_verified) await removed(prev.value, "atproto_record_deleted");
    await deleteRecord();
    return "done";
  }

  const rawUrl = isRecord(msg.record) && typeof msg.record.url === "string" ? msg.record.url : null;
  const norm = rawUrl ? normalizeServerUrl(rawUrl, { allowInsecure: cfg.allowInsecure }) : null;
  if (!norm?.ok) {
    log("info", "atproto server record ignored", { uri, error: norm?.error ?? "no url" });
    return "done";
  }
  const url = norm.value;
  const ident = await verifyIdentity(msg.did);
  const verified = ident.domain !== null && hostIsWithin(new URL(url).hostname, ident.domain);
  const source: EventSource = { kind: "atproto", did: msg.did, handle: ident.handle, uri, cid: msg.cid, domain_verified: verified };

  await env.DB.prepare(
    `INSERT INTO servers (url, first_seen_at, status, last_submitted_at) VALUES (?, ?, 'pending', ?)
     ON CONFLICT(url) DO UPDATE SET last_submitted_at = excluded.last_submitted_at`,
  ).bind(url, nowSec(), nowSec()).run();

  const outcome = await handleProbe(env, url, source, attempt);
  if (outcome !== "done") return outcome;
  if (prev?.value && prev.value !== url && prev.domain_verified) await removed(prev.value, "atproto_record_changed");
  await saveRecord(url, verified);
  return "done";
}

// ------------------------------------------------------------------------------ consumer

async function handle(env: Env, body: WorkMessage, attempt: number): Promise<Outcome> {
  switch (body.kind) {
    case "probe":
      return handleProbe(env, body.url, body.source, attempt);
    case "discover_domain": {
      const cfg = config(env);
      const found = await discoverDomainServers(body.domain, { userAgent: cfg.userAgent, signal: AbortSignal.timeout(20_000) }, { allowInsecure: cfg.allowInsecure });
      if (found) await enqueueCatalogUrls(env, body.domain, found.catalogUrl, found.urls);
      else log("info", "no ai-catalog found", { domain: body.domain });
      return "done";
    }
    case "atproto_commit":
      return handleAtprotoCommit(env, body, attempt);
    case "reverify_index":
      await reverifyIndex(env, body.index_id);
      return "done";
  }
}

export async function consumeWork(batch: MessageBatch<WorkMessage>, env: Env): Promise<void> {
  // Messages are independent; run them concurrently and ack/retry individually.
  await Promise.all(
    batch.messages.map(async (m) => {
      try {
        const outcome = await handle(env, m.body, m.attempts);
        if (outcome === "done") m.ack();
        else m.retry({ delaySeconds: outcome.retryAfter });
      } catch (e) {
        log("error", "work message failed", { kind: m.body.kind, attempt: m.attempts, error: errMessage(e) });
        m.retry({ delaySeconds: 30 * m.attempts });
      }
    }),
  );
}
