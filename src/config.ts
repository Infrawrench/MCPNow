/** Typed view over string env vars (wrangler types them as literals). */
export interface Config {
  publicUrl: string;
  namespace: string;
  serverCollection: string;
  indexCollection: string;
  providerMetaKey: string;
  jetstreamUrl: string;
  dedupeSeconds: number;
  requireEndpointOnDomain: boolean;
  allowInsecure: boolean;
  eventRetentionDays: number;
  recrawlAfterHours: number;
  userAgent: string;
}

export function config(env: Env): Config {
  const ns = String(env.NAMESPACE);
  const publicUrl = String(env.PUBLIC_URL).replace(/\/$/, "");
  return {
    publicUrl,
    namespace: ns,
    serverCollection: `${ns}.server`,
    indexCollection: `${ns}.index`,
    providerMetaKey: `${ns}/provider`,
    jetstreamUrl: String(env.JETSTREAM_URL),
    dedupeSeconds: Number(env.SUBMIT_DEDUPE_SECONDS) || 600,
    requireEndpointOnDomain: String(env.REQUIRE_ENDPOINT_ON_DOMAIN) !== "false",
    allowInsecure: String(env.ALLOW_INSECURE_URLS) === "true",
    eventRetentionDays: Number(env.EVENT_RETENTION_DAYS) || 30,
    recrawlAfterHours: Number(env.RECRAWL_AFTER_HOURS) || 24,
    userAgent: `mcpnow/0.1 (+${publicUrl})`,
  };
}
