import { signatureHeaders } from "./sign";
import { config } from "./config";
import { log, newId, nowSec } from "./util";
import type { DeliverMessage, EventData, EventSource, EventType, McpNowEvent } from "./types";
import type { RecordVersion } from "./dns";

export function makeEvent<T extends EventType>(
  type: T,
  source: McpNowEvent<T>["source"],
  data: EventData[T],
  version: RecordVersion = "1",
): McpNowEvent<T> {
  return { version, id: newId("evt"), type, time: new Date().toISOString(), source, data };
}

/** Persist an event to the log and enqueue one delivery per active index. */
export async function publishEvent(env: Env, event: McpNowEvent, serverUrl: string | null): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO events (id, type, server_url, payload, created_at) VALUES (?, ?, ?, ?, ?) RETURNING seq",
  )
    .bind(event.id, event.type, serverUrl, JSON.stringify(event), nowSec())
    .first<{ seq: number }>();
  const seq = row?.seq ?? 0;

  const { results } = await env.DB.prepare("SELECT id FROM indexes WHERE status = 'active'").all<{ id: string }>();
  for (let i = 0; i < results.length; i += 100) {
    const chunk = results.slice(i, i + 100).map((r) => ({ body: { event_id: event.id, index_id: r.id } satisfies DeliverMessage }));
    await env.DELIVER_QUEUE.sendBatch(chunk);
  }
  log("info", "event published", { type: event.type, id: event.id, seq, url: serverUrl, fanout: results.length });
  return seq;
}

export interface PostOutcome {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
  error: string | null;
}

/** POST one event to an index endpoint, signed. Never throws. */
export async function postEvent(env: Env, endpoint: string, event: McpNowEvent): Promise<PostOutcome> {
  const body = JSON.stringify(event);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": config(env).userAgent,
        "mcpnow-version": event.version,
        "mcpnow-event-id": event.id,
        "mcpnow-event-type": event.type,
        ...(await signatureHeaders(env, body)),
      },
      body,
    });
    await res.body?.cancel();
    if (res.ok) return { ok: true, status: res.status, retryable: false, retryAfterSeconds: null, error: null };
    const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
    const ra = Number(res.headers.get("retry-after"));
    return {
      ok: false,
      status: res.status,
      retryable,
      retryAfterSeconds: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 43_200) : null,
      error: res.status >= 300 && res.status < 400 ? `HTTP ${res.status} (redirects are not followed)` : `HTTP ${res.status}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "TimeoutError" ? "timed out after 10s" : e.message) : String(e);
    return { ok: false, status: null, retryable: true, retryAfterSeconds: null, error: msg };
  }
}

export function pingEvent(indexId: string, version: RecordVersion): McpNowEvent<"mcpnow.ping"> {
  return makeEvent(
    "mcpnow.ping",
    { kind: "mcpnow" },
    { index_id: indexId, message: "Verifying this endpoint for MCPNow. Respond with any 2xx status." },
    version,
  );
}

export type { EventSource };
