// Generates an Ed25519 signing key for webhook signatures.
// Usage: npm run keygen            -> prints the private JWK
//        npm run keygen | npx wrangler secret put SIGNING_KEY_JWK
const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", privateKey);
jwk.kid = `mcpnow-${new Date().toISOString().slice(0, 10)}`;
process.stdout.write(JSON.stringify(jwk));
