import { generateSigningKeys } from './runtime';

// pnpm --filter @jmo/config keygen → prints Ed25519 JWKs for CONFIG_SIGNING_PRIVATE_KEY_JWK and the extension's bundled public key.
const { privateJwk, publicJwk } = await generateSigningKeys();
console.log(`CONFIG_SIGNING_PRIVATE_KEY_JWK='${JSON.stringify(privateJwk)}'`);
console.log(`# Public key to bundle in the extension (apps/extension/lib/config-key.ts):\n${JSON.stringify(publicJwk)}`);
