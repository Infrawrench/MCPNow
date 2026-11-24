/** DNS-over-HTTPS lookups (Cloudflare JSON API). */

const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE_TXT = 16;

/**
 * Parse the `data` field of a TXT answer. DoH JSON returns the RDATA in presentation
 * format: one or more quoted character-strings, e.g. `"mcpnow=https://a" "/b"`.
 * Per RFC 7208 §3.3 style, multiple strings are concatenated.
 */
export function parseTxtData(data: string): string {
  const s = data.trim();
  if (!s.startsWith('"')) return s; // unquoted single string
  let out = "";
  let i = 0;
  while (i < s.length) {
    while (i < s.length && s[i] !== '"') i++;
    if (i >= s.length) break;
    i++; // opening quote
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\" && i + 1 < s.length) {
        const dec = /^\d{3}/.exec(s.slice(i + 1, i + 4));
        if (dec) {
          out += String.fromCharCode(Number(dec[0]));
          i += 4;
        } else {
          out += s[i + 1];
          i += 2;
        }
        continue;
      }
      out += s[i];
      i++;
    }
    i++; // closing quote
  }
  return out;
}

export class DnsError extends Error {}

interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

/** Returns TXT strings for name, [] for NXDOMAIN/NODATA. Throws DnsError on resolver failure. */
export async function lookupTxt(name: string, fetcher: typeof fetch = fetch): Promise<string[]> {
  const url = `${DOH}?name=${encodeURIComponent(name)}&type=TXT`;
  const res = await fetcher(url, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new DnsError(`DNS resolver returned HTTP ${res.status}`);
  const body = (await res.json()) as { Status: number; Answer?: DohAnswer[] };
  if (body.Status === 3) return []; // NXDOMAIN
  if (body.Status !== 0) throw new DnsError(`DNS lookup failed (rcode ${body.Status})`);
  return (body.Answer ?? []).filter((a) => a.type === TYPE_TXT).map((a) => parseTxtData(a.data));
}

export const authKeyName = (key: string, domain: string): string => `${key}._authkey.${domain}`;

/**
 * Record/payload format versions this deployment understands. The `v=` tag is mandatory:
 * there is no implied default, so records always state which version they target.
 */
export const SUPPORTED_RECORD_VERSIONS = ["1"] as const;
export type RecordVersion = (typeof SUPPORTED_RECORD_VERSIONS)[number];

export type AuthRecord =
  | { kind: "missing" }
  | { kind: "ambiguous"; values: string[] }
  | { kind: "invalid"; error: string }
  | { kind: "found"; endpoint: string; version: RecordVersion; tags: Record<string, string> };

/**
 * Parse a tag-list TXT value (SPF/DMARC style): `v=1; mcpnow=https://idx.example/hook`.
 * Tags are `;`-separated, order-independent, case-insensitive names. Returns null if the
 * string has no `mcpnow` tag (i.e. it is some unrelated TXT record).
 */
export function parseTagList(txt: string): Record<string, string> | null {
  const tags: Record<string, string> = {};
  for (const part of txt.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    if (!(name in tags)) tags[name] = p.slice(eq + 1).trim();
  }
  return "mcpnow" in tags ? tags : null;
}

/**
 * Interpret the TXT strings at <key>._authkey.<domain>:
 *   v=1; mcpnow=<endpoint>
 * `v` is required. Unknown tags are ignored (reserved for future versions).
 */
export function parseAuthRecord(txts: string[]): AuthRecord {
  const records = txts.map(parseTagList).filter((t): t is Record<string, string> => t !== null);
  if (records.length === 0) return { kind: "missing" };
  const distinct = [...new Set(records.map((r) => JSON.stringify(r)))];
  if (distinct.length > 1) return { kind: "ambiguous", values: records.map((r) => r.mcpnow ?? "") };
  const tags = records[0]!;
  const v = tags.v;
  if (!v) {
    return {
      kind: "invalid",
      error: `missing required v= tag; expected e.g. "v=${SUPPORTED_RECORD_VERSIONS[0]}; mcpnow=<endpoint>"`,
    };
  }
  if (!(SUPPORTED_RECORD_VERSIONS as readonly string[]).includes(v)) {
    return {
      kind: "invalid",
      error: `unsupported record version "${v}"; supported: ${SUPPORTED_RECORD_VERSIONS.join(", ")}`,
    };
  }
  if (!tags.mcpnow) return { kind: "invalid", error: "mcpnow tag is empty" };
  return { kind: "found", endpoint: tags.mcpnow, version: v as RecordVersion, tags };
}
