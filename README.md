# MCPNow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

IndexNow-style change notification for MCP servers, on Cloudflare Workers.
Full protocol documentation is served at `GET /` (source: `src/docs.ts`).

```
submitter ──GET /index?url=…──▶ Worker ──▶ mcpnow-work queue ──▶ probe MCP server
                                                         │        (+ server card, OAuth metadata)
atproto (Jetstream) ──▶ JetstreamListener DO ────────────┘                 │
                                                                     D1: events, servers
                                                                           │
                                              mcpnow-deliver queue ◀───────┘ (one msg per index)
                                                         │
                                                         ▼
                                       signed POST to each registered index
```

## Layout

| Path | What |
|---|---|
| `src/http.ts` | Router: `/index`, `/register_index`, `/unregister_index`, `/index_status`, `/events`, `/servers`, `/server`, `/.well-known/mcpnow.json` |
| `src/docs.ts` | The `/` documentation page |
| `src/mcp.ts` | MCP probe: modern `server/discover` → legacy `initialize` → legacy SSE |
| `src/discovery.ts` | Server cards (SEP-2127), `/.well-known/ai-catalog.json`, RFC 9728, provider `_meta` merge |
| `src/dns.ts` | DoH TXT lookups, `v=1; mcpnow=<endpoint>` record parsing |
| `src/indexes.ts` | Index registration / revocation / daily re-verification (DNS + atproto) |
| `src/work.ts` | `mcpnow-work` consumer: probes, catalog expansion, atproto commits |
| `src/deliver.ts` | `mcpnow-deliver` consumer: signed webhook delivery, retries, suspension |
| `src/jetstream.ts` | Durable Object holding the Jetstream WebSocket |
| `src/atproto.ts` | DID docs, bidirectional handle verification, PDS `getRecord` |
| `lexicons/` | `app.mcpnow.server`, `app.mcpnow.index` |
| `migrations/` | D1 schema |

## Deploy

```sh
npm install
npx wrangler d1 create mcpnow            # put the id into wrangler.jsonc
npx wrangler queues create mcpnow-work
npx wrangler queues create mcpnow-deliver
npx wrangler queues create mcpnow-dlq
npm run db:migrate:remote
npm run keygen | npx wrangler secret put SIGNING_KEY_JWK
# the mcpnow.app zone must be on the same Cloudflare account (custom domain route)
npm run deploy
```

If you change `NAMESPACE`, rename the lexicon files/ids to match.
To rotate the signing key, generate a new one with a new `kid`. (Only one key is published at a time today.)

## Local development

```sh
echo "SIGNING_KEY_JWK='$(node scripts/keygen.mjs)'" > .dev.vars
npm run db:migrate:local
npx wrangler dev --var ALLOW_INSECURE_URLS:true --test-scheduled
curl "localhost:8787/__scheduled?cron=*+*+*+*+*"     # start the Jetstream listener
curl "localhost:8787/__scheduled?cron=17+4+*+*+*"    # daily: re-verify indexes, recrawl, prune
npm test && npm run typecheck
```

## Cost notes

The Jetstream Durable Object holds an outbound WebSocket, so it stays resident and bills duration continuously.
Roughly a few dollars a month. Remove the `* * * * *` cron to switch atproto off.

## License

MIT, copyright (c) 2026 Infrawrench Services, Inc. See [LICENSE](LICENSE). Repository: <https://github.com/Infrawrench/MCPNow>
