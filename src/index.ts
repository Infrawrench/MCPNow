import { handleFetch } from "./http";
import { consumeWork } from "./work";
import { consumeDeliveries } from "./deliver";
import { config } from "./config";
import { log, nowSec, errMessage } from "./util";
import type { DeliverMessage, WorkMessage } from "./types";

export { JetstreamListener } from "./jetstream";

async function daily(env: Env): Promise<void> {
  const cfg = config(env);
  const now = nowSec();

  // Re-verify every non-revoked index (DNS record / atproto record + domain still valid).
  const { results: idx } = await env.DB.prepare("SELECT id FROM indexes WHERE status != 'revoked'").all<{ id: string }>();
  for (let i = 0; i < idx.length; i += 100) {
    await env.WORK_QUEUE.sendBatch(idx.slice(i, i + 100).map((r) => ({ body: { kind: "reverify_index", index_id: r.id } satisfies WorkMessage })));
  }

  // Recrawl known servers; only changes produce events. Recently-dead servers get a chance to come back.
  const { results: servers } = await env.DB.prepare(
    `SELECT url FROM servers
     WHERE last_probed_at < ?1
       AND (status IN ('ok', 'auth_required') OR (status = 'unreachable' AND last_ok_at > ?2))
     ORDER BY last_probed_at LIMIT 5000`,
  )
    .bind(now - cfg.recrawlAfterHours * 3600, now - 7 * 86_400)
    .all<{ url: string }>();
  for (let i = 0; i < servers.length; i += 100) {
    await env.WORK_QUEUE.sendBatch(
      servers.slice(i, i + 100).map((r) => ({ body: { kind: "probe", url: r.url, source: { kind: "recrawl" } } satisfies WorkMessage })),
    );
  }

  const pruned = await env.DB.prepare("DELETE FROM events WHERE created_at < ?").bind(now - cfg.eventRetentionDays * 86_400).run();
  log("info", "daily maintenance", { reverify: idx.length, recrawl: servers.length, events_pruned: pruned.meta.changes });
}

export default {
  fetch: (req, env) => handleFetch(req, env),

  async queue(batch, env) {
    if (batch.queue.startsWith("mcpnow-work")) return consumeWork(batch as MessageBatch<WorkMessage>, env);
    if (batch.queue.startsWith("mcpnow-deliver")) return consumeDeliveries(batch as MessageBatch<DeliverMessage>, env);
    log("warn", "unknown queue", { queue: batch.queue });
    batch.ackAll();
  },

  async scheduled(controller, env, ctx) {
    if (controller.cron === "* * * * *") {
      const status = await env.JETSTREAM.getByName("main").ensureRunning();
      if (!status.connected) log("warn", "jetstream not connected", { cursor: status.cursor, error: status.last_error });
      return;
    }
    ctx.waitUntil(daily(env).catch((e) => log("error", "daily maintenance failed", { error: errMessage(e) })));
  },
} satisfies ExportedHandler<Env, WorkMessage | DeliverMessage>;
