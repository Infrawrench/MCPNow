import { authKeyName, lookupTxt, parseAuthRecord, DnsError, SUPPORTED_RECORD_VERSIONS, type RecordVersion } from "./dns";
import { getRecord, verifyIdentity } from "./atproto";
import { config } from "./config";
import { pingEvent, postEvent } from "./events";
import { HttpError, isRecord, log, nowSec } from "./util";
import { isValidAuthKey, normalizeDomain, validateEndpoint } from "./validate";
import type { IndexRow } from "./types";

export function publicIndex(row: IndexRow) {
  return {
    id: row.id,
    method: row.method,
    domain: row.domain,
    did: row.did,
    endpoint: row.endpoint,
    version: row.version,
    status: row.status,
    status_reason: row.status_reason,
    verified_at: new Date(row.verified_at * 1000).toISOString(),
    last_success_at: row.last_success_at ? new Date(row.last_success_at * 1000).toISOString() : null,
    last_error: row.last_error,
    consecutive_failures: row.consecutive_failures,
  };
}

async function getIndex(env: Env, id: string): Promise<IndexRow | null> {
  return env.DB.prepare("SELECT * FROM indexes WHERE id = ?").bind(id).first<IndexRow>();
}

async function pingOrThrow(env: Env, id: string, endpoint: string, version: RecordVersion): Promise<void> {
  const out = await postEvent(env, endpoint, pingEvent(id, version));
  if (!out.ok) {
    throw new HttpError(422, "endpoint did not acknowledge the verification ping", {
      endpoint,
      result: out.error,
      hint: "The endpoint must answer a signed POST of an mcpnow.ping event with a 2xx status.",
    });
  }
}

async function upsertActive(
  env: Env,
  fields: { id: string; method: "dns" | "atproto"; domain: string; auth_key?: string; did?: string; rkey?: string; endpoint: string; version: RecordVersion },
): Promise<IndexRow> {
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO indexes (id, method, domain, auth_key, did, rkey, endpoint, version, status, created_at, updated_at, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       domain = excluded.domain, endpoint = excluded.endpoint, version = excluded.version,
       status = 'active', status_reason = NULL, updated_at = excluded.updated_at,
       verified_at = excluded.verified_at, consecutive_failures = 0, last_error = NULL`,
  )
    .bind(fields.id, fields.method, fields.domain, fields.auth_key ?? null, fields.did ?? null, fields.rkey ?? null, fields.endpoint, fields.version, now, now, now)
    .run();
  return (await getIndex(env, fields.id))!;
}

async function setStatus(env: Env, id: string, status: IndexRow["status"], reason: string | null): Promise<void> {
  await env.DB.prepare("UPDATE indexes SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?")
    .bind(status, reason, nowSec(), id)
    .run();
}

// ------------------------------------------------------------------------------ DNS method

function parseDnsParams(domainRaw: string | null, key: string | null): { domain: string; key: string } {
  const d = normalizeDomain(domainRaw ?? "");
  if (!d.ok) throw new HttpError(400, `invalid domain: ${d.error}`);
  if (!key || !isValidAuthKey(key)) {
    throw new HttpError(400, "invalid key: use 8-63 characters of [A-Za-z0-9-], not starting or ending with '-'");
  }
  return { domain: d.value, key };
}

async function readDnsRecord(domain: string, key: string) {
  try {
    return parseAuthRecord(await lookupTxt(authKeyName(key, domain)));
  } catch (e) {
    if (e instanceof DnsError) throw new HttpError(502, e.message);
    throw e;
  }
}

export async function registerDnsIndex(env: Env, domainRaw: string | null, keyRaw: string | null): Promise<IndexRow> {
  const cfg = config(env);
  const { domain, key } = parseDnsParams(domainRaw, keyRaw);
  const name = authKeyName(key, domain);
  const rec = await readDnsRecord(domain, key);
  const example = `v=${SUPPORTED_RECORD_VERSIONS[0]}; mcpnow=https://${domain}/mcpnow`;
  if (rec.kind === "missing") {
    throw new HttpError(404, "auth key TXT record not found", { expected_record: { name, type: "TXT", value: example } });
  }
  if (rec.kind === "ambiguous") throw new HttpError(422, "multiple conflicting mcpnow TXT records", { name, values: rec.values });
  if (rec.kind === "invalid") throw new HttpError(422, rec.error, { name, example });

  const ep = validateEndpoint(rec.endpoint, domain, { allowInsecure: cfg.allowInsecure, requireOnDomain: cfg.requireEndpointOnDomain });
  if (!ep.ok) throw new HttpError(422, ep.error);
  const id = `dns:${domain}:${key}`;
  await pingOrThrow(env, id, ep.value, rec.version);
  const row = await upsertActive(env, { id, method: "dns", domain, auth_key: key, endpoint: ep.value, version: rec.version });
  log("info", "index registered", { id, endpoint: ep.value, method: "dns" });
  return row;
}

/** Unregistering requires proving control again: the TXT record must have been removed. */
export async function unregisterDnsIndex(env: Env, domainRaw: string | null, keyRaw: string | null): Promise<IndexRow> {
  const { domain, key } = parseDnsParams(domainRaw, keyRaw);
  const id = `dns:${domain}:${key}`;
  const row = await getIndex(env, id);
  if (!row) throw new HttpError(404, "no such index");
  const rec = await readDnsRecord(domain, key);
  if (rec.kind !== "missing") {
    throw new HttpError(409, "remove the auth key TXT record first, then call unregister_index again", {
      name: authKeyName(key, domain),
    });
  }
  await setStatus(env, id, "revoked", "unregistered");
  return (await getIndex(env, id))!;
}

export async function indexStatus(env: Env, domainRaw: string | null, keyRaw: string | null): Promise<IndexRow> {
  const { domain, key } = parseDnsParams(domainRaw, keyRaw);
  const row = await getIndex(env, `dns:${domain}:${key}`);
  if (!row) throw new HttpError(404, "no such index");
  return row;
}

// --------------------------------------------------------------------------- atproto method

/** Handle create/update of a `<ns>.index` record. Throws on transient failure (caller retries). */
export async function upsertAtprotoIndex(env: Env, did: string, rkey: string, record: unknown): Promise<"registered" | "rejected"> {
  const cfg = config(env);
  const id = `atproto:${did}:${rkey}`;
  const reject = async (reason: string) => {
    log("warn", "atproto index rejected", { id, reason });
    if (await getIndex(env, id)) await setStatus(env, id, "revoked", reason);
    return "rejected" as const;
  };
  if (!isRecord(record) || typeof record.endpoint !== "string") return reject("record has no endpoint");
  const version = record.version;
  if (typeof version !== "string" || !(SUPPORTED_RECORD_VERSIONS as readonly string[]).includes(version)) {
    return reject(`missing or unsupported version (supported: ${SUPPORTED_RECORD_VERSIONS.join(", ")})`);
  }
  const ident = await verifyIdentity(did);
  if (!ident.domain) return reject("account has no verified domain (handle must resolve back to the DID, or use did:web)");
  const ep = validateEndpoint(record.endpoint, ident.domain, { allowInsecure: cfg.allowInsecure, requireOnDomain: cfg.requireEndpointOnDomain });
  if (!ep.ok) return reject(ep.error);
  const out = await postEvent(env, ep.value, pingEvent(id, version as RecordVersion));
  if (!out.ok) throw new Error(`ping failed: ${out.error}`);
  await upsertActive(env, { id, method: "atproto", domain: ident.domain, did, rkey, endpoint: ep.value, version: version as RecordVersion });
  log("info", "index registered", { id, endpoint: ep.value, method: "atproto" });
  return "registered";
}

export async function revokeAtprotoIndex(env: Env, did: string, rkey: string): Promise<void> {
  const id = `atproto:${did}:${rkey}`;
  if (await getIndex(env, id)) await setStatus(env, id, "revoked", "atproto record deleted");
}

// ------------------------------------------------------------------------------ re-verify

/** Periodic check that an index still controls its domain; reactivates suspended ones that answer. */
export async function reverifyIndex(env: Env, id: string): Promise<void> {
  const cfg = config(env);
  const row = await getIndex(env, id);
  if (!row || row.status === "revoked") return;

  let endpoint = row.endpoint;
  let version: RecordVersion = row.version;
  let domain = row.domain;

  if (row.method === "dns") {
    let rec;
    try {
      rec = parseAuthRecord(await lookupTxt(authKeyName(row.auth_key!, row.domain)));
    } catch {
      return; // resolver trouble: try again next time
    }
    if (rec.kind === "missing") return setStatus(env, id, "revoked", "auth key TXT record removed");
    if (rec.kind !== "found") return setStatus(env, id, "suspended", rec.kind === "invalid" ? rec.error : "ambiguous TXT records");
    endpoint = rec.endpoint;
    version = rec.version;
  } else {
    const ident = await verifyIdentity(row.did!);
    if (!ident.pds) return; // DID doc unavailable: transient
    const rec = await getRecord(ident.pds, row.did!, cfg.indexCollection, row.rkey!);
    if (rec === "error") return;
    if (rec === null) return setStatus(env, id, "revoked", "atproto record deleted");
    if (!ident.domain) return setStatus(env, id, "revoked", "account no longer has a verified domain");
    if (!isRecord(rec.value) || typeof rec.value.endpoint !== "string" || typeof rec.value.version !== "string") {
      return setStatus(env, id, "revoked", "record is invalid");
    }
    if (!(SUPPORTED_RECORD_VERSIONS as readonly string[]).includes(rec.value.version)) {
      return setStatus(env, id, "suspended", `unsupported version ${rec.value.version}`);
    }
    endpoint = rec.value.endpoint;
    version = rec.value.version as RecordVersion;
    domain = ident.domain;
  }

  const ep = validateEndpoint(endpoint, domain, { allowInsecure: cfg.allowInsecure, requireOnDomain: cfg.requireEndpointOnDomain });
  if (!ep.ok) return setStatus(env, id, "suspended", ep.error);

  const changed = ep.value !== row.endpoint || version !== row.version || domain !== row.domain;
  if (row.status === "suspended" || changed) {
    const out = await postEvent(env, ep.value, pingEvent(id, version));
    if (!out.ok) {
      await env.DB.prepare("UPDATE indexes SET last_error = ?, updated_at = ? WHERE id = ?").bind(`reverify ping: ${out.error}`, nowSec(), id).run();
      return;
    }
    await env.DB.prepare(
      `UPDATE indexes SET endpoint = ?, version = ?, domain = ?, status = 'active', status_reason = NULL,
         consecutive_failures = 0, last_error = NULL, verified_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(ep.value, version, domain, nowSec(), nowSec(), id).run();
    return;
  }
  await env.DB.prepare("UPDATE indexes SET verified_at = ? WHERE id = ?").bind(nowSec(), id).run();
}
