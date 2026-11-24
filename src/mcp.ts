/**
 * Probe a remote MCP server and collect its public description.
 *
 * Order of attempts (per the MCP versioning/back-compat rules):
 *   1. modern stateless Streamable HTTP (2026-07-28+): `server/discover`, then `*\/list`
 *   2. legacy Streamable HTTP (2025-11-25 and earlier): `initialize` session
 *   3. legacy HTTP+SSE (2024-11-05): GET for an `endpoint` event, POST into it
 * A 401 at any stage stops the probe and reports the server as auth_required.
 */
import { SseReader } from "./sse";
import { readBoundedText, isRecord, VERSION, errMessage } from "./util";
import type { Era } from "./types";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SSE_PROTOCOL_VERSION = "2024-11-05";

const CLIENT_INFO = { name: "mcpnow", version: VERSION };
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_ITEMS = 1000;

export class AuthRequiredError extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super("server requires authorization");
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`JSON-RPC error ${code}: ${message}`);
  }
}

interface RpcResponse {
  message: Record<string, unknown> | null;
  headers: Headers;
}

interface Session {
  era: Era;
  transport: "streamable-http" | "sse";
  protocolVersion: string;
  init: {
    supportedVersions: string[];
    serverInfo: Record<string, unknown> | null;
    capabilities: Record<string, unknown> | null;
    instructions: string | null;
  };
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface ProbeOptions {
  userAgent: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}

export interface RawProbe {
  era: Era;
  transport: "streamable-http" | "sse";
  protocolVersion: string;
  supportedVersions: string[];
  serverInfo: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  instructions: string | null;
  tools: unknown[] | null;
  prompts: unknown[] | null;
  resources: unknown[] | null;
  resourceTemplates: unknown[] | null;
  /** A list call returned 401 even though discovery/initialize was public. */
  listsNeedAuth: boolean;
  wwwAuthenticate: string | null;
}

const nextId = (): string => crypto.randomUUID();

// ------------------------------------------------------------------------------------------ HTTP

async function postRpc(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  opts: ProbeOptions,
): Promise<RpcResponse> {
  const f = opts.fetcher ?? fetch;
  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": opts.userAgent,
      ...headers,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new AuthRequiredError(res.headers.get("www-authenticate"));
  }
  if (res.status === 202 || res.status === 204) {
    await res.body?.cancel();
    return { message: null, headers: res.headers };
  }
  if (!res.ok) {
    const text = await readBoundedText(res, 64 * 1024).catch(() => "");
    throw new HttpStatusError(res.status, text);
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const wantId = body.id;
  if (ct.includes("text/event-stream")) {
    if (!res.body) throw new Error("empty event stream");
    const reader = new SseReader(res.body, MAX_BODY);
    try {
      for (;;) {
        const ev = await reader.next();
        if (!ev) throw new Error("event stream ended before a response arrived");
        if (ev.event !== "message" || !ev.data) continue;
        const msg = pickResponse(JSON.parse(ev.data), wantId);
        if (msg) return { message: msg, headers: res.headers };
      }
    } finally {
      await reader.cancel();
    }
  }
  const text = await readBoundedText(res, MAX_BODY);
  if (!text.trim()) return { message: null, headers: res.headers };
  const msg = pickResponse(JSON.parse(text), wantId);
  if (!msg) throw new Error("response did not contain a matching JSON-RPC message");
  return { message: msg, headers: res.headers };
}

function pickResponse(parsed: unknown, id: unknown): Record<string, unknown> | null {
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of list) {
    if (isRecord(m) && m.id === id && ("result" in m || "error" in m)) return m;
  }
  return null;
}

function unwrap(msg: Record<string, unknown> | null): Record<string, unknown> {
  if (!msg) throw new Error("no response");
  if (isRecord(msg.error)) {
    throw new RpcError(Number(msg.error.code ?? 0), String(msg.error.message ?? "unknown error"));
  }
  if (!isRecord(msg.result)) throw new Error("JSON-RPC result is not an object");
  return msg.result;
}

const asRecord = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);
const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ------------------------------------------------------------------------- modern (stateless)

async function openModern(url: string, opts: ProbeOptions): Promise<Session> {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
    "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const body = { jsonrpc: "2.0", id: nextId(), method, params: { ...params, _meta: meta } };
    const { message } = await postRpc(
      url,
      body,
      { "mcp-protocol-version": MODERN_PROTOCOL_VERSION, "mcp-method": method },
      opts,
    );
    return unwrap(message);
  };
  const result = await request("server/discover");
  const resultMeta = asRecord(result._meta);
  const supported = Array.isArray(result.supportedVersions) ? result.supportedVersions.map(String) : [];
  if (supported.length > 0 && !supported.includes(MODERN_PROTOCOL_VERSION)) {
    throw new Error(`server/discover: server does not support ${MODERN_PROTOCOL_VERSION}`);
  }
  return {
    era: "modern",
    transport: "streamable-http",
    protocolVersion: MODERN_PROTOCOL_VERSION,
    init: {
      supportedVersions: supported,
      serverInfo: asRecord(resultMeta?.["io.modelcontextprotocol/serverInfo"]) ?? asRecord(result.serverInfo),
      capabilities: asRecord(result.capabilities),
      instructions: asString(result.instructions),
    },
    request,
    close: async () => {},
  };
}

// ------------------------------------------------------------- legacy streamable HTTP session

async function openLegacyStreamable(url: string, opts: ProbeOptions): Promise<Session> {
  const initBody = {
    jsonrpc: "2.0",
    id: nextId(),
    method: "initialize",
    params: { protocolVersion: LEGACY_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  };
  const { message, headers } = await postRpc(url, initBody, {}, opts);
  const result = unwrap(message);
  const sessionId = headers.get("mcp-session-id");
  const negotiated = asString(result.protocolVersion) ?? LEGACY_PROTOCOL_VERSION;
  const sessionHeaders: Record<string, string> = { "mcp-protocol-version": negotiated };
  if (sessionId) sessionHeaders["mcp-session-id"] = sessionId;

  await postRpc(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders, opts).catch(() => null);

  return {
    era: "legacy-streamable-http",
    transport: "streamable-http",
    protocolVersion: negotiated,
    init: {
      supportedVersions: [negotiated],
      serverInfo: asRecord(result.serverInfo),
      capabilities: asRecord(result.capabilities),
      instructions: asString(result.instructions),
    },
    request: async (method, params = {}) => {
      const { message } = await postRpc(url, { jsonrpc: "2.0", id: nextId(), method, params }, sessionHeaders, opts);
      return unwrap(message);
    },
    close: async () => {
      if (!sessionId) return;
      try {
        const res = await (opts.fetcher ?? fetch)(url, {
          method: "DELETE",
          headers: { ...sessionHeaders, "user-agent": opts.userAgent },
          signal: opts.signal,
        });
        await res.body?.cancel();
      } catch {
        /* best effort */
      }
    },
  };
}

// ------------------------------------------------------------------------- legacy HTTP + SSE

async function openLegacySse(url: string, opts: ProbeOptions): Promise<Session> {
  const f = opts.fetcher ?? fetch;
  const res = await f(url, {
    headers: { accept: "text/event-stream", "user-agent": opts.userAgent },
    signal: opts.signal,
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new AuthRequiredError(res.headers.get("www-authenticate"));
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !ct.includes("text/event-stream") || !res.body) {
    await res.body?.cancel();
    throw new HttpStatusError(res.status, `not an SSE endpoint (content-type: ${ct})`);
  }
  const reader = new SseReader(res.body, MAX_BODY);
  let endpoint: string | null = null;
  try {
    for (;;) {
      const ev = await reader.next();
      if (!ev) throw new Error("SSE stream ended before endpoint event");
      if (ev.event === "endpoint") {
        endpoint = new URL(ev.data.trim(), url).toString();
        break;
      }
    }
    if (new URL(endpoint).origin !== new URL(url).origin) throw new Error("SSE endpoint is cross-origin");
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  const postUrl = endpoint;

  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId();
    const { message } = await postRpc(postUrl, { jsonrpc: "2.0", id, method, params }, {}, opts);
    if (message) return unwrap(message); // some servers answer inline
    for (;;) {
      const ev = await reader.next();
      if (!ev) throw new Error("SSE stream closed");
      if (ev.event !== "message" || !ev.data) continue;
      const msg = pickResponse(JSON.parse(ev.data), id);
      if (msg) return unwrap(msg);
    }
  };

  try {
    const result = await request("initialize", {
      protocolVersion: SSE_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await postRpc(postUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, {}, opts).catch(() => null);
    const negotiated = asString(result.protocolVersion) ?? SSE_PROTOCOL_VERSION;
    return {
      era: "legacy-sse",
      transport: "sse",
      protocolVersion: negotiated,
      init: {
        supportedVersions: [negotiated],
        serverInfo: asRecord(result.serverInfo),
        capabilities: asRecord(result.capabilities),
        instructions: asString(result.instructions),
      },
      request,
      close: () => reader.cancel(),
    };
  } catch (e) {
    await reader.cancel();
    throw e;
  }
}

// ------------------------------------------------------------------------------------ lists

async function listAll(session: Session, method: string, key: string): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && items.length < MAX_ITEMS; page++) {
    const result = await session.request(method, cursor ? { cursor } : {});
    const batch = result[key];
    if (Array.isArray(batch)) items.push(...batch);
    cursor = asString(result.nextCursor) ?? undefined;
    if (!cursor) break;
  }
  return items.slice(0, MAX_ITEMS);
}

// ------------------------------------------------------------------------------------ entry

export async function probeMcp(url: string, opts: ProbeOptions): Promise<RawProbe> {
  const attempts: Array<[string, () => Promise<Session>]> = [
    ["modern", () => openModern(url, opts)],
    ["legacy-streamable-http", () => openLegacyStreamable(url, opts)],
    ["legacy-sse", () => openLegacySse(url, opts)],
  ];
  const errors: string[] = [];
  let session: Session | null = null;
  for (const [name, open] of attempts) {
    try {
      session = await open();
      break;
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      if (opts.signal.aborted) throw new Error(`probe timed out (${[...errors, `${name}: aborted`].join("; ")})`);
      errors.push(`${name}: ${errMessage(e)}`);
    }
  }
  if (!session) throw new Error(`not a reachable MCP server (${errors.join("; ")})`);

  const caps = session.init.capabilities ?? {};
  let listsNeedAuth = false;
  let wwwAuthenticate: string | null = null;
  const tryList = async (cap: string, method: string, key: string): Promise<unknown[] | null> => {
    if (!(cap in caps)) return null;
    try {
      return await listAll(session, method, key);
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        listsNeedAuth = true;
        wwwAuthenticate ??= e.wwwAuthenticate;
      }
      return null;
    }
  };

  try {
    // Sequential: legacy SSE sessions share one response stream.
    const tools = await tryList("tools", "tools/list", "tools");
    const prompts = await tryList("prompts", "prompts/list", "prompts");
    const resources = await tryList("resources", "resources/list", "resources");
    const resourceTemplates = await tryList("resources", "resources/templates/list", "resourceTemplates");
    return {
      era: session.era,
      transport: session.transport,
      protocolVersion: session.protocolVersion,
      supportedVersions: session.init.supportedVersions,
      serverInfo: session.init.serverInfo,
      capabilities: session.init.capabilities,
      instructions: session.init.instructions,
      tools,
      prompts,
      resources,
      resourceTemplates,
      listsNeedAuth,
      wwwAuthenticate,
    };
  } finally {
    await session.close();
  }
}

/** Extract `resource_metadata="..."` from a WWW-Authenticate: Bearer challenge (RFC 9728 §5.1). */
export function parseResourceMetadataUrl(wwwAuthenticate: string | null): string | null {
  if (!wwwAuthenticate) return null;
  const m = /resource_metadata\s*=\s*"([^"]+)"/i.exec(wwwAuthenticate) ?? /resource_metadata\s*=\s*([^\s,]+)/i.exec(wwwAuthenticate);
  return m?.[1] ?? null;
}
