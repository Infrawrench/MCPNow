/**
 * Technical documentation served at GET /.
 * Markdown is the single source; clients whose Accept header mentions text/markdown get it raw,
 * everyone else gets it rendered into a deliberately plain HTML page.
 */
import { Marked } from "marked";
import { gfmHeadingId } from "marked-gfm-heading-id";
import { config } from "./config";
import { SUPPORTED_RECORD_VERSIONS } from "./dns";
import { LEGACY_PROTOCOL_VERSION, MODERN_PROTOCOL_VERSION } from "./mcp";

export const REPO_URL = "https://github.com/Infrawrench/MCPNow";

// Parser configuration only (no request data), so one instance per isolate is fine.
const markdown = new Marked(gfmHeadingId());

export function docsMarkdown(env: Env): string {
  const c = config(env);
  const base = c.publicUrl;
  const v = SUPPORTED_RECORD_VERSIONS.join(", ");
  const onDomain = c.requireEndpointOnDomain;
  return `# MCPNow

IndexNow-style change notification for [Model Context Protocol](https://modelcontextprotocol.io) servers.
Anyone can tell MCPNow that a remote MCP server exists or changed. MCPNow probes the server, gathers its public
description, and pushes a signed event to every registered *index* (directories, registries, search engines, clients).

Every record and payload carries an explicit version (currently \`${v}\`). There is no default version.

MCPNow is open source under the [MIT licence](${REPO_URL}/blob/main/LICENSE). Source code, issues and lexicons:
[Infrawrench/MCPNow](${REPO_URL}).

This page is also available as markdown: request \`${base}/\` with \`Accept: text/markdown\`.

**Contents:** [Submitting servers](#submitting-servers) · [What gets probed](#what-gets-probed) ·
[Server cards & provider metadata](#server-cards--provider-metadata) · [Registering an index](#registering-an-index) ·
[Webhook delivery](#webhook-delivery) · [Event types](#event-types) · [Feeds & history](#feeds--history) ·
[atproto](#atproto) · [Limits](#limits) · [Endpoint reference](#endpoint-reference) · [Source & licence](#source--licence)

## Submitting servers

\`\`\`
GET  ${base}/index?url=https://mcp.example.com/mcp
GET  ${base}/index?domain=example.com
POST ${base}/index        Content-Type: application/json
     {"urls": ["https://mcp.example.com/mcp", ...], "domains": ["example.com"]}
\`\`\`

- \`url\` (also accepted as \`URL\`): the MCP endpoint (Streamable HTTP, or the legacy SSE endpoint). Must be \`https\`
  with a public hostname. No IP literals or credentials, and no credential-looking query parameters such as \`key\`,
  \`token\` or \`api_key\`, because the URL is broadcast publicly.
- \`domain\`, or a bare origin such as \`?url=https://example.com/\`: MCPNow reads
  \`https://<domain>/.well-known/ai-catalog.json\` and submits every MCP remote listed in it.
  See [server cards](#server-cards--provider-metadata).
- Up to 100 URLs/domains per request. The same URL is accepted once per ${c.dedupeSeconds}s. Later submissions in
  that window report \`"duplicate"\`.
- No key is needed to submit. Submissions only trigger a probe, and indexes only receive what the server itself says.

Response \`202\` (or \`422\` if every input was rejected):

\`\`\`json
{"results": [{"input": "...", "status": "queued" | "duplicate" | "rejected", "url": "...", "error": "..."}]}
\`\`\`

## What gets probed

Each submitted URL is probed from a queue, up to 3 attempts with backoff. Attempts in order:

1. **Modern stateless Streamable HTTP** (\`${MODERN_PROTOCOL_VERSION}\`): \`POST server/discover\` with headers
   \`MCP-Protocol-Version\`, \`Mcp-Method\` and \`_meta["io.modelcontextprotocol/protocolVersion"]\`, then \`tools/list\` etc.
2. **Legacy Streamable HTTP**: \`initialize\` (offering \`${LEGACY_PROTOCOL_VERSION}\`), then \`notifications/initialized\`,
   the list calls using \`Mcp-Session-Id\`, and finally \`DELETE\` of the session.
3. **Legacy HTTP+SSE** (\`2024-11-05\`): \`GET\` the URL, wait for the \`endpoint\` event (which must be same-origin),
   and \`POST\` requests into it.

Both JSON and \`text/event-stream\` responses are accepted. List calls (\`tools/list\`, \`prompts/list\`,
\`resources/list\`, \`resources/templates/list\`) are only made for capabilities the server declares. They follow
\`nextCursor\` for up to 10 pages or 1000 items.

**Auth.** A \`401\` marks the server \`auth_required\`. MCPNow then reads
[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) protected resource metadata, first from
\`WWW-Authenticate: Bearer resource_metadata="…"\`, then from \`/.well-known/oauth-protected-resource{path}\`, then from
\`/.well-known/oauth-protected-resource\`. It records \`authorization_servers\` and \`scopes_supported\`. If discovery
is public but a list call returns 401, the event has partial data and \`auth.required: true\`.

Results larger than ~400 KB are trimmed in two steps: tool \`inputSchema\`/\`outputSchema\` are removed first, then
lists are cut. Trimmed results have \`truncated: true\`. Known servers are re-probed every ${c.recrawlAfterHours}h.
A recrawl only emits an event if something changed.

## Server cards & provider metadata

MCPNow supports MCP Server Cards
([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md)).
For each server it looks in two places:

1. \`GET <server-url>/server-card\` with \`Accept: application/mcp-server-card+json\`
2. \`GET https://<host>/.well-known/ai-catalog.json\`. It takes entries with
   \`type: "application/mcp-server-card+json"\` (inline \`data\` or by \`url\`) and picks the card whose
   \`remotes[].url\` matches.

The card is passed through in \`data.server_card\` as \`{url, via, same_origin, card}\`. \`same_origin\` is true only
when the card was fetched over HTTPS from the server's own origin. Under SEP-2127's trust rule, a card that is not
same-origin should not drive security decisions.

### Provider extension: \`_meta["${c.providerMetaKey}"]\`

Server cards don't cover legal and support details. Cards allow reverse-DNS-keyed \`_meta\`, so MCPNow defines this
block in the card:

\`\`\`json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
  "name": "com.example/weather",
  "version": "1.0.0",
  "description": "Weather tools",
  "websiteUrl": "https://example.com",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.example.com/mcp" }],
  "_meta": {
    "${c.providerMetaKey}": {
      "privacyPolicyUrl":  "https://example.com/privacy",
      "termsOfServiceUrl": "https://example.com/terms",
      "supportUrl":        "https://example.com/support",
      "supportEmail":      "support@example.com",
      "documentationUrl":  "https://example.com/docs/mcp"
    }
  }
}
\`\`\`

All fields are optional. Events carry a merged \`data.provider\` object. For each field, the first source that has it
wins: card \`_meta\` extension, then card top-level fields, then RFC 9728 metadata (\`resource_name\`,
\`resource_documentation\`, \`resource_policy_uri\`, \`resource_tos_uri\`), then MCP \`serverInfo\`.
\`provider.sources\` says which source supplied each field.

Domain ownership comes from DNS (for indexes) and from atproto handles (\`source.domain_verified\`). See below.

## Registering an index

### DNS

Pick a key: 8–63 characters of \`[A-Za-z0-9-]\`, not starting or ending with \`-\`. Publish a TXT record:

\`\`\`
<key>._authkey.<your-domain>.  TXT  "v=${SUPPORTED_RECORD_VERSIONS[0]}; mcpnow=https://<your-domain>/mcpnow-webhook"
\`\`\`

- Tag list in SPF/DMARC style: \`;\`-separated, order-independent. **\`v\` is required**. Supported: \`${v}\`.
  Unknown tags are ignored and reserved for later versions.
- \`mcpnow\` is the webhook endpoint. It must be \`https\`${onDomain ? ", on the domain or a subdomain of it" : ""}.
  A literal \`;\` in the URL must be percent-encoded.
- A TXT value split into several strings is concatenated before parsing.

Then call:

\`\`\`
GET ${base}/register_index?domain=<your-domain>&key=<key>
\`\`\`

MCPNow resolves the record over DNS-over-HTTPS (1.1.1.1) and validates the endpoint. It then sends a signed
\`mcpnow.ping\` event, and **the endpoint must answer with a 2xx**. On success, the index is active and receives every
later event. Errors explain what is wrong. For example, a missing record returns \`404\` with the exact expected record.

\`\`\`
GET ${base}/index_status?domain=…&key=…       → current status, last delivery error, failure count
GET ${base}/unregister_index?domain=…&key=…    → remove the TXT record first, then call this (proves control)
\`\`\`

Registrations are re-verified daily. If the record has disappeared, the index is revoked. If the endpoint or version
changed, the index is re-pinged and updated. To change the endpoint, edit the TXT record and call \`register_index\`
again.

### atproto

An atproto account with a verified domain can advertise an index by publishing a \`${c.indexCollection}\` record.
See [atproto](#atproto).

## Webhook delivery

\`\`\`
POST <endpoint>
Content-Type:      application/json
User-Agent:        ${c.userAgent}
MCPNow-Version:    ${SUPPORTED_RECORD_VERSIONS[0]}
MCPNow-Event-Id:   evt_…
MCPNow-Event-Type: mcp.server.updated
MCPNow-Timestamp:  1764000000
MCPNow-Signature:  keyid=<kid>,ed25519=<base64url signature>
\`\`\`

- **Signature:** Ed25519 over the bytes \`<MCPNow-Timestamp>.<raw request body>\`. Public keys (JWK) are at
  [\`/.well-known/mcpnow.json\`](${base}/.well-known/mcpnow.json) under \`signing.keys\`, matched by \`kid\`.
  Reject stale timestamps (more than 5 minutes old is a reasonable limit).
- **Success** is any 2xx within 10 s. Redirects are not followed.
- **Retries:** network errors, timeouts, 408, 425, 429 and 5xx are retried with exponential backoff (30 s doubling,
  capped at 12 h, up to 10 attempts). \`Retry-After\` is honoured. Other 4xx responses are not retried.
- **At-least-once:** the same event can arrive more than once, so deduplicate on \`id\`. Order is not guaranteed.
  Use \`seq\` to order events.
- **Suspension:** after 100 consecutive failures with no success for 24 h, the index is suspended. The daily
  re-verification re-pings suspended indexes and reactivates any that answer. Calling \`register_index\` again also
  reactivates. Use \`/events\` to catch up on anything missed.

### Verifying (Node / Workers)

\`\`\`js
const wk  = await (await fetch("${base}/.well-known/mcpnow.json")).json();
const jwk = wk.signing.keys.find(k => k.kid === kidFromHeader);
const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
const ok  = await crypto.subtle.verify({ name: "Ed25519" }, key,
              base64urlDecode(sigFromHeader), new TextEncoder().encode(\`\${timestamp}.\${rawBody}\`));
\`\`\`

## Event types

Envelope (all types):

\`\`\`jsonc
{
  "version": "${SUPPORTED_RECORD_VERSIONS[0]}",
  "id":      "evt_…",                 // unique; dedupe on this
  "type":    "mcp.server.updated",
  "time":    "2026-11-24T00:00:00.000Z",
  "seq":     1234,                    // global order (absent on mcpnow.ping)
  "source":  { … },
  "data":    { … }
}
\`\`\`

| type | when | data |
|---|---|---|
| \`mcp.server.updated\` | A probe succeeded (status \`ok\` or \`auth_required\`) after a submission, an atproto record, a catalog expansion, or a recrawl that found a change. | Full probe result (below), plus \`changed\` (bool: differs from last probe) and \`previous_status\`. |
| \`mcp.server.unreachable\` | A server that previously probed OK failed 3 attempts in a row. | \`{url, error, last_ok_at}\` |
| \`mcp.server.removed\` | A domain-verified atproto \`${c.serverCollection}\` record was deleted, or now points elsewhere. | \`{url, reason: "atproto_record_deleted" \\| "atproto_record_changed"}\` |
| \`mcpnow.ping\` | Endpoint verification during registration and re-verification. Only that one index receives it. | \`{index_id, message}\` |

### \`source\`

\`\`\`jsonc
{"kind": "http", "submitted_at": "…"}
{"kind": "recrawl"}
{"kind": "catalog", "domain": "example.com", "catalog_url": "https://example.com/.well-known/ai-catalog.json"}
{"kind": "atproto", "did": "did:plc:…", "handle": "example.com", "uri": "at://…", "cid": "…", "domain_verified": true}
{"kind": "mcpnow"}   // pings
\`\`\`

### \`mcp.server.updated\` data

\`\`\`jsonc
{
  "url": "https://mcp.example.com/mcp",
  "status": "ok" | "auth_required",
  "era": "modern" | "legacy-streamable-http" | "legacy-sse" | null,
  "transport": "streamable-http" | "sse" | null,
  "protocol_version": "${MODERN_PROTOCOL_VERSION}",
  "supported_versions": ["${MODERN_PROTOCOL_VERSION}"],
  "server_info": { "name": "…", "version": "…", … },     // as reported by the server
  "capabilities": { "tools": {}, … },
  "instructions": "…" | null,
  "tools": [ … ] | null,              // null = not declared / not readable
  "prompts": [ … ] | null,
  "resources": [ … ] | null,
  "resource_templates": [ … ] | null,
  "truncated": false,
  "auth": { "required": bool, "resource_metadata_url": "…", "resource_metadata": { … },
            "authorization_servers": ["…"], "scopes_supported": ["…"] },
  "server_card": { "url": "…", "via": "server-card-path" | "ai-catalog", "same_origin": bool, "card": { … } } | null,
  "provider": { "name", "title", "description", "version", "icons": [], "website_url", "documentation_url",
                "privacy_policy_url", "terms_of_service_url", "support_url", "support_email",
                "sources": { "<field>": "server-card" | "provider-meta" | "resource-metadata" | "server-info" } },
  "probed_at": "…",
  "changed": true,
  "previous_status": "ok" | "auth_required" | "unreachable" | null
}
\`\`\`

Everything a server reports about itself is self-declared and unverified. Treat it as untrusted input. In particular,
tool descriptions can contain prompt-injection text.

## Feeds & history

### \`GET /events?after=<seq>&limit=<1..500>[&url=<server>]\`

The event log in \`seq\` order, kept for ${c.eventRetentionDays} days. It returns \`{events, next_after, has_more}\`.
New indexes can use it to backfill, and any index can use it to recover missed deliveries. Pings are not logged.

### \`GET /servers?after=<cursor>&limit=<1..1000>[&include=all]\`

> **This is a history, not a directory.** \`/servers\` lists the MCP server URLs MCPNow has been given, in first-seen
> order. It is **not** a definitive or current list of working MCP servers. Entries may be offline, moved, or no
> longer MCP servers. \`last_status\` is only what was observed at \`last_probed_at\`.

By default it lists only URLs that answered as an MCP server at least once. \`include=all\` lists every accepted
submission. Each entry is \`{url, first_seen_at, last_status, last_probed_at, last_ok_at}\`. Paginate with
\`next_after\`.

### \`GET /server?url=<server>\`

Latest stored state and last probe result for one URL. The same historical caveat applies.

## atproto

MCPNow subscribes to the network through Jetstream (\`${c.jetstreamUrl}\`), filtered to two collections.
The lexicon JSON is in the repository under [\`lexicons/\`](${REPO_URL}/tree/main/lexicons).

### \`${c.serverCollection}\`: announce a server

\`\`\`json
{ "$type": "${c.serverCollection}", "url": "https://mcp.example.com/mcp", "createdAt": "…" }
\`\`\`

- **Create/update:** the server is probed and \`mcp.server.updated\` is emitted with an atproto \`source\`.
- \`source.domain_verified\` is true when the account's verified domain is the server's host or a parent of it. A
  verified domain is a handle whose \`_atproto\` TXT record or \`/.well-known/atproto-did\` resolves back to the DID,
  or the host of a \`did:web\`.
- **Delete**, or an update that points at a different URL, emits \`mcp.server.removed\`, but **only if the record was
  domain-verified**. Records from unverified accounts can announce a server but cannot delist one.

### \`${c.indexCollection}\`: advertise an index

\`\`\`json
{ "$type": "${c.indexCollection}", "version": "${SUPPORTED_RECORD_VERSIONS[0]}", "endpoint": "https://example.com/mcpnow-webhook", "createdAt": "…" }
\`\`\`

- The account must have a verified domain (see above). \`version\` is required. The endpoint must be
  \`https\`${onDomain ? " on that domain or a subdomain of it" : ""}.
- The endpoint must answer the \`mcpnow.ping\` with a 2xx. The index id is \`atproto:<did>:<rkey>\`.
- Deleting the record revokes the index. The daily re-verification also re-reads the record from the PDS and
  re-checks the handle.

## Limits

| | |
|---|---|
| Submissions | 120 requests / minute / IP. At most 100 URLs or domains per request. Repeat submissions of a URL are deduplicated for ${c.dedupeSeconds}s. |
| Index registration | 10 requests / minute / IP |
| Probe | 45 s overall, 4 MB per response, 10 pages / 1000 items per list |
| Catalog expansion | Up to 20 cards and 50 remote URLs per domain. Templated remote URLs are skipped. |
| Event retention | ${c.eventRetentionDays} days |

## Endpoint reference

| Method & path | Purpose |
|---|---|
| \`GET /\` | This page (\`Accept: text/markdown\` for markdown) |
| \`GET /.well-known/mcpnow.json\` | Machine-readable discovery: endpoints, supported versions, collections, signing keys |
| \`GET\\|POST /index\` | Submit server URLs or domains |
| \`GET /register_index?domain&key\` | Register or refresh a DNS-verified index |
| \`GET /unregister_index?domain&key\` | Revoke (after the TXT record is removed) |
| \`GET /index_status?domain&key\` | Index status and delivery health |
| \`GET /events\` | Event log / backfill |
| \`GET /servers\` | History of submitted servers (not a directory) |
| \`GET /server?url\` | Last known state of one server |

Errors are JSON: \`{"error": "…", "detail": …}\`. CORS is open on every endpoint.

## Source & licence

MCPNow is open source software released under the [MIT licence](${REPO_URL}/blob/main/LICENSE).
Code, issues and contributions: [github.com/Infrawrench/MCPNow](${REPO_URL}). You can run your own instance on
Cloudflare Workers; see the repository README.

Copyright (c) 2026 Infrawrench Services, Inc.
`;
}

const STYLE = `
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; color: #111; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #ddd; background: #111; } code, pre { background: #222 !important; } th, td { border-color: #444 !important; } a { color: #8ab4f8; } }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.25rem; margin-top: 2.5rem; border-bottom: 1px solid #8884; } h3 { font-size: 1.05rem; margin-top: 1.5rem; }
  code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f4f4; }
  code { padding: 0 .2em; } pre { padding: .75rem; overflow-x: auto; } pre code { padding: 0; background: none; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; } th, td { border: 1px solid #ccc; padding: .3rem .5rem; text-align: left; vertical-align: top; }
  blockquote { margin: 1rem 0; border-left: 3px solid #c90; padding: .25rem .75rem; }`;

/** True if the client mentions text/markdown anywhere in Accept (q-values are not considered). */
export function wantsMarkdown(req: Request): boolean {
  return (req.headers.get("accept") ?? "").toLowerCase().includes("text/markdown");
}

const DESCRIPTION =
  "IndexNow-style change notification for Model Context Protocol servers: submit an MCP server URL, " +
  "MCPNow probes it and pushes signed events to every registered index.";

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function docsPage(env: Env, req: Request): Response {
  const { publicUrl } = config(env);
  const md = docsMarkdown(env);
  const headers = { "cache-control": "public, max-age=300", vary: "Accept" };
  if (wantsMarkdown(req)) {
    return new Response(md, { headers: { ...headers, "content-type": "text/markdown; charset=utf-8" } });
  }
  const body = markdown.parse(md, { async: false });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCPNow: technical documentation</title>
<meta name="description" content="${attr(DESCRIPTION)}">
<link rel="canonical" href="${attr(publicUrl)}/">
<link rel="alternate" type="text/markdown" href="${attr(publicUrl)}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MCPNow">
<meta property="og:title" content="MCPNow: technical documentation">
<meta property="og:description" content="${attr(DESCRIPTION)}">
<meta property="og:url" content="${attr(publicUrl)}/">
<meta property="og:locale" content="en">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="MCPNow: technical documentation">
<meta name="twitter:description" content="${attr(DESCRIPTION)}">
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
  return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
