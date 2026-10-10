import { generateVaultKeyPair } from './index';

// pnpm --filter @jmo/vault keygen → vault key pair. The PRIVATE key goes only to the API Worker's secrets.
const { publicJwk, privateJwk } = await generateVaultKeyPair();
console.log(`VAULT_PUBLIC_KEY_JWK='${JSON.stringify(publicJwk)}'`);
console.log(`VAULT_PRIVATE_KEY_JWK='${JSON.stringify(privateJwk)}'`);
