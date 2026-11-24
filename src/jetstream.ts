/**
 * Long-lived Jetstream subscriber. Filters the atproto firehose down to our two collections
 * (<ns>.server and <ns>.index) and pushes each commit onto the work queue.
 *
 * Reliability: the cursor (time_us) only advances after a commit is enqueued and is persisted
 * every alarm tick; on reconnect we rewind a few seconds and the consumer dedupes by CID.
 * A per-minute cron calls ensureRunning(), and a 30s alarm reconnects if the socket dropped.
 */
import { DurableObject } from "cloudflare:workers";
import { config } from "./config";
import { errMessage, isRecord, log } from "./util";
import type { WorkMessage } from "./types";

const ALARM_MS = 30_000;
const REWIND_US = 5_000_000;

export class JetstreamListener extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private cursor: number | null = null;
  private persistedCursor: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private commitsSeen = 0;
  private lastError: string | null = null;

  async ensureRunning(): Promise<{ connected: boolean; cursor: number | null; commits_seen: number; last_error: string | null }> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    await this.ensureSocket().catch((e) => {
      this.lastError = errMessage(e);
    });
    return { connected: this.ws !== null, cursor: this.cursor, commits_seen: this.commitsSeen, last_error: this.lastError };
  }

  /** Read-only snapshot for /status. Does not open a connection. */
  async status(): Promise<{ connected: boolean; cursor: number | null; next_alarm: number | null; commits_seen: number; last_error: string | null }> {
    const cursor = this.cursor ?? (await this.ctx.storage.get<number>("cursor")) ?? null;
    return {
      connected: this.ws !== null,
      cursor,
      next_alarm: await this.ctx.storage.getAlarm(),
      commits_seen: this.commitsSeen,
      last_error: this.lastError,
    };
  }

  override async alarm(): Promise<void> {
    try {
      await this.ensureSocket();
    } catch (e) {
      this.lastError = errMessage(e);
      log("warn", "jetstream connect failed", { error: this.lastError });
    }
    await this.persistCursor();
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  private async persistCursor(): Promise<void> {
    if (this.cursor !== null && this.cursor !== this.persistedCursor) {
      await this.ctx.storage.put("cursor", this.cursor);
      this.persistedCursor = this.cursor;
    }
  }

  private ensureSocket(): Promise<void> {
    if (this.ws) return Promise.resolve();
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<void> {
    const cfg = config(this.env);
    if (this.cursor === null) {
      this.cursor = (await this.ctx.storage.get<number>("cursor")) ?? null;
      this.persistedCursor = this.cursor;
    }
    const url = new URL(cfg.jetstreamUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
    url.searchParams.append("wantedCollections", cfg.serverCollection);
    url.searchParams.append("wantedCollections", cfg.indexCollection);
    if (this.cursor !== null) url.searchParams.set("cursor", String(this.cursor - REWIND_US));

    const res = await fetch(url.toString(), { headers: { upgrade: "websocket", "user-agent": cfg.userAgent } });
    const ws = res.webSocket;
    if (!ws) {
      await res.body?.cancel();
      throw new Error(`jetstream upgrade failed: HTTP ${res.status}`);
    }
    ws.accept();
    this.ws = ws;
    this.lastError = null;
    log("info", "jetstream connected", { cursor: this.cursor, collections: [cfg.serverCollection, cfg.indexCollection] });

    const collections = new Set([cfg.serverCollection, cfg.indexCollection]);
    ws.addEventListener("message", (e) => {
      const data = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      this.chain = this.chain
        .then(() => this.onMessage(ws, data, collections))
        .catch((err) => {
          // Couldn't enqueue: drop the socket so we reconnect from the last good cursor.
          this.lastError = errMessage(err);
          log("error", "jetstream message handling failed", { error: this.lastError });
          this.drop(ws);
        });
    });
    const onGone = (why: string) => () => {
      if (this.ws === ws) {
        this.ws = null;
        log("warn", "jetstream disconnected", { why });
      }
    };
    ws.addEventListener("close", onGone("close"));
    ws.addEventListener("error", onGone("error"));
  }

  private drop(ws: WebSocket): void {
    if (this.ws === ws) this.ws = null;
    try {
      ws.close(1011, "reconnecting");
    } catch {
      /* already closed */
    }
  }

  private async onMessage(ws: WebSocket, data: string, collections: Set<string>): Promise<void> {
    if (this.ws !== ws) return; // stale socket
    const msg: unknown = JSON.parse(data);
    if (!isRecord(msg) || typeof msg.time_us !== "number") return;
    const commit = msg.commit;
    if (msg.kind === "commit" && isRecord(commit) && typeof commit.collection === "string" && collections.has(commit.collection)) {
      const op = commit.operation;
      if ((op === "create" || op === "update" || op === "delete") && typeof msg.did === "string" && typeof commit.rkey === "string") {
        const body: WorkMessage = {
          kind: "atproto_commit",
          did: msg.did,
          collection: commit.collection,
          rkey: commit.rkey,
          operation: op,
          cid: typeof commit.cid === "string" ? commit.cid : null,
          record: commit.record ?? null,
          time_us: msg.time_us,
        };
        await this.env.WORK_QUEUE.send(body);
        this.commitsSeen++;
      }
    }
    this.cursor = msg.time_us;
  }
}
