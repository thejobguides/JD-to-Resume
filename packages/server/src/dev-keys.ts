import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateSigningKeys } from '@jmo/config';
import { generateVaultKeyPair } from '@jmo/vault';

// Development only (Node): creates and persists local vault + config-signing keys in .dev/keys.json so vault
// entries survive restarts. Production keys come from secrets and are never written to disk.

export interface DevKeys {
  vault: { publicJwk: JsonWebKey; privateJwk: JsonWebKey };
  signing: { publicJwk: JsonWebKey; privateJwk: JsonWebKey };
}

export async function loadOrCreateDevKeys(path: string): Promise<DevKeys> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as DevKeys;
  const keys: DevKeys = { vault: await generateVaultKeyPair(), signing: await generateSigningKeys() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}
