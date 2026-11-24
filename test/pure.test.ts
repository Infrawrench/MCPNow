import { describe, expect, it } from "vitest";
import { parseAuthRecord, parseTagList, parseTxtData } from "../src/dns";
import { parseBlock, SseReader } from "../src/sse";
import { hostIsWithin, isBareOrigin, isValidAuthKey, normalizeDomain, normalizeServerUrl, validateEndpoint } from "../src/validate";
import { parseResourceMetadataUrl } from "../src/mcp";
import { buildProviderInfo } from "../src/discovery";
import { stableStringify } from "../src/util";

const strict = { allowInsecure: false };

describe("TXT records", () => {
  it("joins multi-string TXT data and unescapes", () => {
    expect(parseTxtData('"v=1; mcpnow=https://a.example" "/hook"')).toBe("v=1; mcpnow=https://a.example/hook");
    expect(parseTxtData('"a\\"b\\059c"')).toBe('a"b;c');
  });
  it("parses tag lists in any order", () => {
    expect(parseTagList("mcpnow=https://x.io/h; v=1")).toEqual({ mcpnow: "https://x.io/h", v: "1" });
    expect(parseTagList("google-site-verification=abc")).toBeNull();
  });
  it("requires an explicit version", () => {
    expect(parseAuthRecord(["mcpnow=https://x.io/h"])).toMatchObject({ kind: "invalid" });
    expect(parseAuthRecord(["v=2; mcpnow=https://x.io/h"])).toMatchObject({ kind: "invalid" });
    expect(parseAuthRecord(["v=1; mcpnow=https://x.io/h", "unrelated"])).toEqual({
      kind: "found",
      endpoint: "https://x.io/h",
      version: "1",
      tags: { v: "1", mcpnow: "https://x.io/h" },
    });
  });
  it("detects missing and conflicting records", () => {
    expect(parseAuthRecord([])).toEqual({ kind: "missing" });
    expect(parseAuthRecord(["v=1; mcpnow=https://a.io", "v=1; mcpnow=https://b.io"])).toMatchObject({ kind: "ambiguous" });
  });
});

describe("validation", () => {
  it("normalises server URLs", () => {
    expect(normalizeServerUrl("https://MCP.Example.com/mcp#x", strict)).toEqual({ ok: true, value: "https://mcp.example.com/mcp" });
    expect(normalizeServerUrl("http://mcp.example.com/mcp", strict).ok).toBe(false);
    expect(normalizeServerUrl("https://127.0.0.1/mcp", strict).ok).toBe(false);
    expect(normalizeServerUrl("https://localhost/mcp", strict).ok).toBe(false);
    expect(normalizeServerUrl("https://u:p@mcp.example.com/", strict).ok).toBe(false);
    expect(normalizeServerUrl("https://mcp.example.com/mcp?api_key=secret", strict).ok).toBe(false);
    expect(normalizeServerUrl("https://mcp.example.com/mcp?tenant=a", strict).ok).toBe(true);
  });
  it("validates domains and keys", () => {
    expect(normalizeDomain("Example.COM.")).toEqual({ ok: true, value: "example.com" });
    expect(normalizeDomain("bücher.de")).toEqual({ ok: true, value: "xn--bcher-kva.de" });
    expect(normalizeDomain("nodots").ok).toBe(false);
    expect(normalizeDomain("a_b.com").ok).toBe(false);
    expect(isValidAuthKey("abcd1234")).toBe(true);
    expect(isValidAuthKey("short")).toBe(false);
    expect(isValidAuthKey("-abcdefgh")).toBe(false);
    expect(isValidAuthKey("a".repeat(64))).toBe(false);
  });
  it("keeps endpoints on the verified domain", () => {
    const opts = { allowInsecure: false, requireOnDomain: true };
    expect(validateEndpoint("https://hooks.idx.example.org/x", "idx.example.org", opts).ok).toBe(true);
    expect(validateEndpoint("https://evil.org/x", "idx.example.org", opts).ok).toBe(false);
    expect(validateEndpoint("https://notidx.example.org/x", "idx.example.org", opts).ok).toBe(false);
    expect(hostIsWithin("a.b.c.com", "c.com")).toBe(true);
    expect(hostIsWithin("xc.com", "c.com")).toBe(false);
  });
  it("detects bare origins", () => {
    expect(isBareOrigin("https://example.com/")).toBe(true);
    expect(isBareOrigin("https://example.com/mcp")).toBe(false);
  });
});

describe("SSE", () => {
  it("parses blocks", () => {
    expect(parseBlock("event: endpoint\ndata: /messages?s=1")).toEqual({ event: "endpoint", data: "/messages?s=1" });
    expect(parseBlock(": keepalive")).toBeNull();
    expect(parseBlock("data: a\ndata: b\nid: 7")).toEqual({ event: "message", data: "a\nb", id: "7" });
  });
  it("reads events across chunk boundaries and CRLF", async () => {
    const enc = new TextEncoder();
    const chunks = ["event: endpoint\r\nda", "ta: /m\r\n\r\ndata: {\"id\":1}\n", "\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    const r = new SseReader(stream);
    expect(await r.next()).toEqual({ event: "endpoint", data: "/m" });
    expect(await r.next()).toEqual({ event: "message", data: '{"id":1}' });
    expect(await r.next()).toBeNull();
  });
});

describe("discovery helpers", () => {
  it("extracts resource_metadata from WWW-Authenticate", () => {
    expect(parseResourceMetadataUrl('Bearer error="invalid_token", resource_metadata="https://a.io/.well-known/oauth-protected-resource"')).toBe(
      "https://a.io/.well-known/oauth-protected-resource",
    );
    expect(parseResourceMetadataUrl("Bearer")).toBeNull();
  });
  it("merges provider info with _meta extension taking precedence", () => {
    const card = {
      name: "com.example/weather",
      description: "Weather",
      websiteUrl: "https://example.com",
      _meta: { "app.mcpnow/provider": { privacyPolicyUrl: "https://example.com/privacy", supportEmail: "help@example.com" } },
    };
    const p = buildProviderInfo(card, { name: "weather-server", version: "1.2.0" }, { resource_tos_uri: "https://example.com/tos" }, "app.mcpnow/provider");
    expect(p).toMatchObject({
      name: "com.example/weather",
      version: "1.2.0",
      privacy_policy_url: "https://example.com/privacy",
      terms_of_service_url: "https://example.com/tos",
      support_email: "help@example.com",
      website_url: "https://example.com/",
    });
    expect(p.sources).toMatchObject({ name: "server-card", version: "server-info", privacy_policy_url: "provider-meta", terms_of_service_url: "resource-metadata" });
  });
  it("stable stringify is key-order independent", () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(stableStringify({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});
