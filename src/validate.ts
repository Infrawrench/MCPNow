/** Pure input validation. No Workers-only imports so it can be unit tested in Node. */

export interface UrlPolicy {
  allowInsecure: boolean;
}

const MAX_URL_LENGTH = 2048;

// Query parameters that almost certainly carry credentials. We refuse to broadcast these.
const SECRET_PARAM = /^(api[-_]?key|key|token|access[-_]?token|auth|authorization|secret|password|pass|session|sig|signature|jwt)$/i;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function isForbiddenHost(hostname: string, policy: UrlPolicy): string | null {
  if (hostname.startsWith("[") || IPV4.test(hostname)) {
    return policy.allowInsecure ? null : "IP address hosts are not allowed";
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return policy.allowInsecure ? null : "localhost is not allowed";
  }
  if (!hostname.includes(".")) return policy.allowInsecure ? null : "host must be a public domain name";
  if (/\.(local|internal|lan|home\.arpa|test|invalid|example)$/.test(hostname)) {
    return "reserved / non-public TLD";
  }
  return null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** Normalise a URL that should point at a remote MCP server. */
export function normalizeServerUrl(raw: string, policy: UrlPolicy): Result<string> {
  if (!raw || raw.length > MAX_URL_LENGTH) return { ok: false, error: "url missing or too long" };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "not a valid URL" };
  }
  if (u.protocol !== "https:" && !(policy.allowInsecure && u.protocol === "http:")) {
    return { ok: false, error: "url must use https" };
  }
  if (u.username || u.password) return { ok: false, error: "url must not contain credentials" };
  const hostErr = isForbiddenHost(u.hostname, policy);
  if (hostErr) return { ok: false, error: hostErr };
  for (const name of u.searchParams.keys()) {
    if (SECRET_PARAM.test(name)) {
      return { ok: false, error: `url query parameter "${name}" looks like a credential; refusing to broadcast it` };
    }
  }
  u.hash = "";
  return { ok: true, value: u.toString() };
}

/** Normalise a bare domain name (IDN -> punycode, lowercase, no trailing dot). */
export function normalizeDomain(raw: string): Result<string> {
  const trimmed = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253) return { ok: false, error: "domain missing or too long" };
  let host: string;
  try {
    host = new URL(`https://${trimmed}/`).hostname;
  } catch {
    return { ok: false, error: "not a valid domain" };
  }
  if (host !== trimmed && host !== new URL(`https://${host}/`).hostname) return { ok: false, error: "not a valid domain" };
  const labels = host.split(".");
  if (labels.length < 2) return { ok: false, error: "domain must have at least two labels" };
  for (const l of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return { ok: false, error: `invalid label "${l}"` };
  }
  if (IPV4.test(host)) return { ok: false, error: "IP addresses are not domains" };
  return { ok: true, value: host };
}

/** Auth keys become a DNS label: <key>._authkey.<domain>. */
export function isValidAuthKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{6,61}[A-Za-z0-9]$/.test(key ?? "");
}

export function hostIsWithin(hostname: string, domain: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase().replace(/\.$/, "");
  return h === d || h.endsWith(`.${d}`);
}

/** Validate an index webhook endpoint against the domain it was verified for. */
export function validateEndpoint(
  raw: string,
  domain: string,
  opts: UrlPolicy & { requireOnDomain: boolean },
): Result<string> {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: `endpoint "${raw}" is not a valid URL` };
  }
  if (u.protocol !== "https:" && !(opts.allowInsecure && u.protocol === "http:")) {
    return { ok: false, error: "endpoint must use https" };
  }
  if (u.username || u.password) return { ok: false, error: "endpoint must not contain credentials" };
  const hostErr = isForbiddenHost(u.hostname, opts);
  if (hostErr) return { ok: false, error: `endpoint: ${hostErr}` };
  if (opts.requireOnDomain && !hostIsWithin(u.hostname, domain)) {
    return { ok: false, error: `endpoint host ${u.hostname} must be ${domain} or a subdomain of it` };
  }
  u.hash = "";
  return { ok: true, value: u.toString() };
}

/** Is this URL just an origin (no meaningful path), i.e. "discover what's on this site"? */
export function isBareOrigin(url: string): boolean {
  const u = new URL(url);
  return (u.pathname === "/" || u.pathname === "") && !u.search;
}
