/**
 * Out-of-band discovery around an MCP server:
 *  - MCP Server Cards (SEP-2127): `<server-url>/server-card` and `/.well-known/ai-catalog.json`
 *  - OAuth protected resource metadata (RFC 9728)
 *  - provider details (privacy policy, terms, support...) carried in the card's `_meta`
 *    under `<namespace>/provider`, since cards allow reverse-DNS-keyed `_meta` extensions.
 */
import { readBoundedJson, isRecord } from "./util";
import { normalizeServerUrl, type UrlPolicy } from "./validate";
import { parseResourceMetadataUrl, type RawProbe } from "./mcp";
import type { AuthInfo, ProbeResult, ProviderInfo, ServerCardInfo } from "./types";

export const SERVER_CARD_MEDIA_TYPE = "application/mcp-server-card+json";
const AI_CATALOG_MEDIA_TYPE = "application/ai-catalog+json";
const MAX_DOC = 256 * 1024;
const MAX_CATALOG_CARDS = 20;

interface Ctx {
  userAgent: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}

async function getJson(url: string, accept: string, ctx: Ctx): Promise<{ body: unknown; finalUrl: string } | null> {
  try {
    const res = await (ctx.fetcher ?? fetch)(url, {
      headers: { accept: `${accept}, application/json;q=0.9`, "user-agent": ctx.userAgent },
      signal: ctx.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("json")) {
      await res.body?.cancel();
      return null;
    }
    return { body: await readBoundedJson(res, MAX_DOC), finalUrl: res.url || url };
  } catch {
    return null;
  }
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

function looksLikeCard(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && (typeof v.name === "string" || Array.isArray(v.remotes));
}

function cardRemoteUrls(card: Record<string, unknown>): Array<{ url: string; type: string }> {
  if (!Array.isArray(card.remotes)) return [];
  return card.remotes
    .filter(isRecord)
    .filter((r) => typeof r.url === "string" && !r.url.includes("{")) // skip templated URLs
    .map((r) => ({ url: String(r.url), type: String(r.type ?? "streamable-http") }));
}

// ----------------------------------------------------------------------------- AI catalog

export interface CatalogCard {
  card: Record<string, unknown>;
  cardUrl: string;
  /** Fetched over HTTPS from the card URL itself (not inline catalog data). */
  fetched: boolean;
}

export async function fetchAiCatalog(origin: string, ctx: Ctx): Promise<{ catalogUrl: string; cards: CatalogCard[] } | null> {
  const catalogUrl = `${origin}/.well-known/ai-catalog.json`;
  const got = await getJson(catalogUrl, AI_CATALOG_MEDIA_TYPE, ctx);
  if (!got || !isRecord(got.body) || !Array.isArray(got.body.entries)) return null;
  const entries = got.body.entries.filter(isRecord).filter((e) => e.type === SERVER_CARD_MEDIA_TYPE);
  const cards: CatalogCard[] = [];
  for (const e of entries.slice(0, MAX_CATALOG_CARDS)) {
    if (looksLikeCard(e.data)) {
      cards.push({ card: e.data, cardUrl: catalogUrl, fetched: false });
    } else if (typeof e.url === "string") {
      let cardUrl: string;
      try {
        cardUrl = new URL(e.url, catalogUrl).toString();
      } catch {
        continue;
      }
      const c = await getJson(cardUrl, SERVER_CARD_MEDIA_TYPE, ctx);
      if (c && looksLikeCard(c.body)) cards.push({ card: c.body, cardUrl: c.finalUrl, fetched: true });
    }
  }
  return { catalogUrl, cards };
}

/** Every remote MCP URL advertised by a domain's AI catalog. */
export async function discoverDomainServers(
  domain: string,
  ctx: Ctx,
  policy: UrlPolicy,
): Promise<{ catalogUrl: string; urls: string[] } | null> {
  const origin = policy.allowInsecure && domain.startsWith("localhost") ? `http://${domain}` : `https://${domain}`;
  const catalog = await fetchAiCatalog(origin, ctx);
  if (!catalog) return null;
  const urls = new Set<string>();
  for (const { card } of catalog.cards) {
    for (const r of cardRemoteUrls(card)) {
      const n = normalizeServerUrl(r.url, policy);
      if (n.ok) urls.add(n.value);
    }
  }
  return { catalogUrl: catalog.catalogUrl, urls: [...urls].slice(0, 50) };
}

// ----------------------------------------------------------------------------- server card

export async function findServerCard(serverUrl: string, ctx: Ctx): Promise<ServerCardInfo | null> {
  const server = new URL(serverUrl);
  const httpsSameOrigin = (u: string): boolean => {
    try {
      const x = new URL(u);
      return x.protocol === "https:" && x.origin === server.origin;
    } catch {
      return false;
    }
  };

  // 1. Recommended location: <streamable-http-url>/server-card
  const direct = `${serverUrl.replace(/\/+$/, "")}/server-card`;
  const got = await getJson(direct, SERVER_CARD_MEDIA_TYPE, ctx);
  if (got && looksLikeCard(got.body)) {
    return { url: got.finalUrl, same_origin: httpsSameOrigin(got.finalUrl), via: "server-card-path", card: got.body };
  }

  // 2. The origin's AI catalog, matching on remotes[].url
  const catalog = await fetchAiCatalog(server.origin, ctx);
  for (const c of catalog?.cards ?? []) {
    if (cardRemoteUrls(c.card).some((r) => sameUrl(r.url, serverUrl))) {
      return {
        url: c.cardUrl,
        same_origin: c.fetched && httpsSameOrigin(c.cardUrl),
        via: "ai-catalog",
        card: c.card,
      };
    }
  }
  return null;
}

// ----------------------------------------------------------------------- OAuth (RFC 9728)

export async function fetchAuthInfo(serverUrl: string, wwwAuthenticate: string | null, ctx: Ctx): Promise<AuthInfo> {
  const candidates: string[] = [];
  const fromHeader = parseResourceMetadataUrl(wwwAuthenticate);
  if (fromHeader) {
    try {
      candidates.push(new URL(fromHeader, serverUrl).toString());
    } catch {
      /* ignore bad header */
    }
  }
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  if (path) candidates.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  candidates.push(`${u.origin}/.well-known/oauth-protected-resource`);

  for (const url of [...new Set(candidates)]) {
    const got = await getJson(url, "application/json", ctx);
    if (got && isRecord(got.body)) {
      const md = got.body;
      return {
        required: true,
        resource_metadata_url: url,
        resource_metadata: md,
        authorization_servers: Array.isArray(md.authorization_servers) ? md.authorization_servers.map(String) : [],
        scopes_supported: Array.isArray(md.scopes_supported) ? md.scopes_supported.map(String) : [],
      };
    }
  }
  return {
    required: true,
    resource_metadata_url: fromHeader,
    resource_metadata: null,
    authorization_servers: [],
    scopes_supported: [],
  };
}

const noAuth = (): AuthInfo => ({
  required: false,
  resource_metadata_url: null,
  resource_metadata: null,
  authorization_servers: [],
  scopes_supported: [],
});

// ------------------------------------------------------------------------- provider info

const httpUrl = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
};
const shortText = (v: unknown, max = 1000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const email = (v: unknown): string | null =>
  typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length < 320 ? v : null;

/**
 * Merge provider details. Precedence per field: server card `_meta[<ns>/provider]` >
 * server card top-level > RFC 9728 resource metadata > MCP serverInfo.
 */
export function buildProviderInfo(
  card: Record<string, unknown> | null,
  serverInfo: Record<string, unknown> | null,
  resourceMetadata: Record<string, unknown> | null,
  providerMetaKey: string,
): ProviderInfo {
  const ext = isRecord(card?._meta) && isRecord(card._meta[providerMetaKey]) ? card._meta[providerMetaKey] : null;
  const sources: Record<string, string> = {};
  const pick = <T>(field: string, candidates: Array<[string, T | null]>): T | null => {
    for (const [src, v] of candidates) {
      if (v !== null && v !== undefined) {
        sources[field] = src;
        return v;
      }
    }
    return null;
  };
  const icons = pick<unknown[]>("icons", [
    ["server-card", Array.isArray(card?.icons) ? card.icons : null],
    ["server-info", Array.isArray(serverInfo?.icons) ? serverInfo.icons : null],
  ]);
  return {
    name: pick("name", [["server-card", shortText(card?.name, 200)], ["server-info", shortText(serverInfo?.name, 200)]]),
    title: pick("title", [["server-card", shortText(card?.title, 200)], ["server-info", shortText(serverInfo?.title, 200)], ["resource-metadata", shortText(resourceMetadata?.resource_name, 200)]]),
    description: pick("description", [["server-card", shortText(card?.description)], ["server-info", shortText(serverInfo?.description)]]),
    version: pick("version", [["server-card", shortText(card?.version, 255)], ["server-info", shortText(serverInfo?.version, 255)]]),
    icons: (icons ?? []).slice(0, 10),
    website_url: pick("website_url", [["server-card", httpUrl(card?.websiteUrl)], ["server-info", httpUrl(serverInfo?.websiteUrl)]]),
    documentation_url: pick("documentation_url", [["provider-meta", httpUrl(ext?.documentationUrl)], ["resource-metadata", httpUrl(resourceMetadata?.resource_documentation)]]),
    privacy_policy_url: pick("privacy_policy_url", [["provider-meta", httpUrl(ext?.privacyPolicyUrl)], ["resource-metadata", httpUrl(resourceMetadata?.resource_policy_uri)]]),
    terms_of_service_url: pick("terms_of_service_url", [["provider-meta", httpUrl(ext?.termsOfServiceUrl)], ["resource-metadata", httpUrl(resourceMetadata?.resource_tos_uri)]]),
    support_url: pick("support_url", [["provider-meta", httpUrl(ext?.supportUrl)]]),
    support_email: pick("support_email", [["provider-meta", email(ext?.supportEmail)]]),
    sources,
  };
}

// ----------------------------------------------------------------------------- assembly

const MAX_RESULT_BYTES = 400 * 1024;

function shrink(result: ProbeResult): ProbeResult {
  const size = (r: ProbeResult) => new TextEncoder().encode(JSON.stringify(r)).byteLength;
  if (size(result) <= MAX_RESULT_BYTES) return result;
  const stripSchemas = (items: unknown[] | null) =>
    items?.map((t) => (isRecord(t) ? { ...t, inputSchema: undefined, outputSchema: undefined } : t)) ?? null;
  let r: ProbeResult = { ...result, truncated: true, tools: stripSchemas(result.tools) };
  if (size(r) <= MAX_RESULT_BYTES) return r;
  for (const n of [200, 50, 10]) {
    r = {
      ...r,
      tools: r.tools?.slice(0, n) ?? null,
      prompts: r.prompts?.slice(0, n) ?? null,
      resources: r.resources?.slice(0, n) ?? null,
      resource_templates: r.resource_templates?.slice(0, n) ?? null,
    };
    if (size(r) <= MAX_RESULT_BYTES) return r;
  }
  return { ...r, instructions: r.instructions?.slice(0, 4000) ?? null };
}

export async function assembleProbeResult(
  url: string,
  probe: RawProbe | { authRequired: string | null },
  ctx: Ctx & { providerMetaKey: string },
): Promise<ProbeResult> {
  const card = await findServerCard(url, ctx);
  const raw = "authRequired" in probe ? null : probe;
  const needsAuth = raw === null || raw.listsNeedAuth;
  const wwwAuth = raw === null ? (probe as { authRequired: string | null }).authRequired : raw.wwwAuthenticate;
  const auth = needsAuth ? await fetchAuthInfo(url, wwwAuth, ctx) : noAuth();
  const cardRemote = card ? cardRemoteUrls(card.card).find((r) => sameUrl(r.url, url)) : undefined;

  return shrink({
    url,
    status: raw === null ? "auth_required" : "ok",
    era: raw?.era ?? null,
    transport: raw?.transport ?? (cardRemote?.type === "sse" ? "sse" : cardRemote ? "streamable-http" : null),
    protocol_version: raw?.protocolVersion ?? null,
    supported_versions: raw?.supportedVersions ?? [],
    server_info: raw?.serverInfo ?? null,
    capabilities: raw?.capabilities ?? null,
    instructions: raw?.instructions ?? null,
    tools: raw?.tools ?? null,
    prompts: raw?.prompts ?? null,
    resources: raw?.resources ?? null,
    resource_templates: raw?.resourceTemplates ?? null,
    truncated: false,
    auth,
    server_card: card,
    provider: buildProviderInfo(card?.card ?? null, raw?.serverInfo ?? null, auth.resource_metadata, ctx.providerMetaKey),
    probed_at: new Date().toISOString(),
  });
}
