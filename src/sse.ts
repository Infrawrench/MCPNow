/** Minimal incremental text/event-stream parser. */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseReader {
  private buf = "";
  private readonly decoder = new TextDecoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private bytes = 0;
  private done = false;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly maxBytes = 4 * 1024 * 1024,
  ) {
    this.reader = stream.getReader();
  }

  /** Next complete event, or null at end of stream. */
  async next(): Promise<SseEvent | null> {
    for (;;) {
      const ev = this.takeEvent();
      if (ev) return ev;
      if (this.done) return null;
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        this.buf += this.decoder.decode();
        if (this.buf.trim()) this.buf += "\n\n"; // flush a trailing event with no blank line
        continue;
      }
      this.bytes += value.byteLength;
      if (this.bytes > this.maxBytes) {
        await this.cancel();
        throw new Error("event stream exceeded size limit");
      }
      this.buf += this.decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
    }
  }

  async cancel(): Promise<void> {
    this.done = true;
    try {
      await this.reader.cancel();
    } catch {
      /* already closed */
    }
  }

  private takeEvent(): SseEvent | null {
    for (;;) {
      const end = this.buf.indexOf("\n\n");
      if (end === -1) return null;
      const block = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 2);
      const ev = parseBlock(block);
      if (ev) return ev;
    }
  }
}

export function parseBlock(block: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  let id: string | undefined;
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0 && event === "message") return null;
  return { event, data: data.join("\n"), ...(id === undefined ? {} : { id }) };
}
