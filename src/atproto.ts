/** atproto identity helpers: DID docs, bidirectional handle verification, record fetches. */
import { lookupTxt } from "./dns";
import { readBoundedJson, readBoundedText, isRecord } from "./util";
import { normalizeDomain } from "./validate";

const PLC_DIRECTORY = "https://plc.directory";
const TIMEOUT_MS = 8000;

export interface DidDocument {
  id: string;
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export function isDid(v: string): boolean {
  return /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.%-]+)$/.test(v);
}

export async function resolveDidDoc(did: string): Promise<DidDocument | null> {
  let url: string;
  if (did.startsWith("did:plc:")) url = `${PLC_DIRECTORY}/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${decodeURIComponent(did.slice("did:web:".length))}/.well-known/did.json`;
  else return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const doc = await readBoundedJson<DidDocument>(res, 64 * 1024);
    return isRecord(doc) && doc.id === did ? doc : null;
  } catch {
    return null;
  }
}

export function handleFromDoc(doc: DidDocument): string | null {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
  return aka ? aka.slice("at://".length).toLowerCase() : null;
}

export function pdsFromDoc(doc: DidDocument): string | null {
  const svc = doc.service?.find((s) => s.id === "#atproto_pds" || s.id === `${doc.id}#atproto_pds`);
  return typeof svc?.serviceEndpoint === "string" ? svc.serviceEndpoint.replace(/\/+$/, "") : null;
}

/** Resolve handle -> DID via DNS `_atproto.<handle>` TXT, then HTTPS well-known. */
export async function resolveHandle(handle: string): Promise<string | null> {
  try {
    const txts = await lookupTxt(`_atproto.${handle}`);
    const dids = txts.filter((t) => t.startsWith("did=")).map((t) => t.slice(4).trim());
    if (dids.length === 1) return dids[0]!;
  } catch {
    /* fall through to HTTPS */
  }
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const did = (await readBoundedText(res, 2048)).trim();
    return isDid(did) ? did : null;
  } catch {
    return null;
  }
}

export interface VerifiedIdentity {
  did: string;
  handle: string | null;
  /** Domain this DID provably controls: a bidirectionally verified handle, or the did:web host. */
  domain: string | null;
  pds: string | null;
}

export async function verifyIdentity(did: string): Promise<VerifiedIdentity> {
  const doc = await resolveDidDoc(did);
  if (!doc) return { did, handle: null, domain: null, pds: null };
  const handle = handleFromDoc(doc);
  const pds = pdsFromDoc(doc);
  if (did.startsWith("did:web:")) {
    const host = normalizeDomain(decodeURIComponent(did.slice("did:web:".length)).split(":")[0]!);
    return { did, handle, domain: host.ok ? host.value : null, pds };
  }
  if (handle && handle !== "handle.invalid") {
    const back = await resolveHandle(handle);
    const norm = normalizeDomain(handle);
    if (back === did && norm.ok) return { did, handle, domain: norm.value, pds };
  }
  return { did, handle, domain: null, pds };
}

/** Fetch a record straight from the account's PDS. Returns null if it no longer exists. */
export async function getRecord(
  pds: string,
  did: string,
  collection: string,
  rkey: string,
): Promise<{ value: unknown; cid: string | null } | null | "error"> {
  const url = `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 400 || res.status === 404) {
      const body = await readBoundedText(res, 8192).catch(() => "");
      return /RecordNotFound|not found|Could not locate record/i.test(body) ? null : "error";
    }
    if (!res.ok) {
      await res.body?.cancel();
      return "error";
    }
    const body = await readBoundedJson<{ value?: unknown; cid?: string }>(res, 256 * 1024);
    return { value: body.value, cid: body.cid ?? null };
  } catch {
    return "error";
  }
}
