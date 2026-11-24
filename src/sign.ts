import { base64url } from "./util";

/**
 * Webhook signatures: Ed25519 over `${timestamp}.${body}`.
 * Headers: MCPNow-Timestamp: <unix seconds>, MCPNow-Signature: keyid=<kid>,ed25519=<base64url sig>
 * Public keys: GET /.well-known/mcpnow.json -> signing_keys[] (JWK).
 */

interface SigningKey {
  kid: string;
  key: CryptoKey;
  publicJwk: JsonWebKey & { kid: string };
}

let cached: { raw: string; key: Promise<SigningKey | null> } | null = null;

export function getSigningKey(env: Env): Promise<SigningKey | null> {
  const raw = env.SIGNING_KEY_JWK;
  if (!raw) return Promise.resolve(null);
  // Cache the imported key per isolate. It's derived only from the secret, never request data.
  if (cached?.raw === raw) return cached.key;
  const key = (async () => {
    const jwk = JSON.parse(raw) as JsonWebKey & { kid?: string };
    const kid = jwk.kid ?? "default";
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
    const publicJwk = { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, kid, alg: "EdDSA", use: "sig" };
    return { kid, key, publicJwk };
  })();
  cached = { raw, key };
  return key;
}

export async function signatureHeaders(env: Env, body: string): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = { "mcpnow-timestamp": ts };
  const sk = await getSigningKey(env);
  if (sk) {
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, sk.key, new TextEncoder().encode(`${ts}.${body}`));
    headers["mcpnow-signature"] = `keyid=${sk.kid},ed25519=${base64url(sig)}`;
  }
  return headers;
}
