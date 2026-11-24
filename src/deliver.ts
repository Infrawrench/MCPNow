/** Consumer for the `mcpnow-deliver` queue: POST events to index endpoints with retries. */
import { postEvent } from "./events";
import { errMessage, log, mapLimit, nowSec } from "./util";
import type { DeliverMessage, IndexRow, McpNowEvent } from "./types";

const MAX_ATTEMPTS = 10;
const SUSPEND_AFTER_FAILURES = 100;
const SUSPEND_AFTER_SECONDS_WITHOUT_SUCCESS = 86_400;

function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 43_200); // 30s, 1m, 2m ... capped at 12h
}

async function loadByIds<T>(env: Env, sql: string, ids: string[]): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const { results } = await env.DB.prepare(sql.replace("?*", chunk.map(() => "?").join(",")))
      .bind(...chunk)
      .all<T & { id: string }>();
    for (const r of results) map.set(r.id, r);
  }
  return map;
}

export async function consumeDeliveries(batch: MessageBatch<DeliverMessage>, env: Env): Promise<void> {
  const indexes = await loadByIds<IndexRow>(env, "SELECT * FROM indexes WHERE id IN (?*)", batch.messages.map((m) => m.body.index_id));
  const events = await loadByIds<{ id: string; seq: number; payload: string }>(
    env,
    "SELECT id, seq, payload FROM events WHERE id IN (?*)",
    batch.messages.map((m) => m.body.event_id),
  );

  await mapLimit(batch.messages, 10, async (m) => {
    const idx = indexes.get(m.body.index_id);
    const ev = events.get(m.body.event_id);
    if (!idx || idx.status !== "active" || !ev) {
      m.ack(); // index gone/suspended or event pruned: nothing to do (indexes can backfill from /events)
      return;
    }
    try {
      const event = { ...(JSON.parse(ev.payload) as McpNowEvent), seq: ev.seq, version: idx.version };
      const out = await postEvent(env, idx.endpoint, event);
      const now = nowSec();
      if (out.ok) {
        await env.DB.prepare(
          "UPDATE indexes SET last_attempt_at = ?, last_success_at = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?",
        ).bind(now, now, idx.id).run();
        m.ack();
        return;
      }
      await env.DB.prepare(
        `UPDATE indexes SET last_attempt_at = ?1, last_error = ?2, consecutive_failures = consecutive_failures + 1,
           status = CASE WHEN consecutive_failures + 1 >= ?3 AND COALESCE(last_success_at, created_at) < ?4 THEN 'suspended' ELSE status END,
           status_reason = CASE WHEN consecutive_failures + 1 >= ?3 AND COALESCE(last_success_at, created_at) < ?4
                                THEN 'too many failed deliveries' ELSE status_reason END
         WHERE id = ?5`,
      ).bind(now, out.error, SUSPEND_AFTER_FAILURES, now - SUSPEND_AFTER_SECONDS_WITHOUT_SUCCESS, idx.id).run();
      if (out.retryable && m.attempts < MAX_ATTEMPTS) {
        m.retry({ delaySeconds: out.retryAfterSeconds ?? backoffSeconds(m.attempts) });
      } else {
        log("warn", "delivery dropped", { index: idx.id, event: ev.id, attempts: m.attempts, error: out.error });
        m.ack();
      }
    } catch (e) {
      log("error", "delivery crashed", { index: idx.id, error: errMessage(e) });
      m.retry({ delaySeconds: backoffSeconds(m.attempts) });
    }
  });
}
