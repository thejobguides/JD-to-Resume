// Write-only provider-key vault (admin-panel.md §6.5.2).
// encryptSecret() runs IN THE ADMIN'S BROWSER with the vault PUBLIC key: the plaintext key never reaches the
// admin API, its logs or the database. decryptSecret() runs only in the API Worker, which alone holds the
// PRIVATE key (a Cloudflare secret / env var). Hybrid scheme: random AES-256-GCM data key, wrapped with RSA-OAEP-256.

export interface EncryptedSecret {
  ciphertext: string; // base64
  wrapped_dek: string; // base64
  iv: string; // base64
  vault_key_version: number;
  last4: string;
}

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function generateVaultKeyPair(): Promise<{ publicJwk: JsonWebKey; privateJwk: JsonWebKey }> {
  const kp = (await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt'])) as CryptoKeyPair;
  return { publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
}

/** Browser side. `secret` is the provider API key the owner pasted. */
export async function encryptSecret(secret: string, publicJwk: JsonWebKey, keyVersion: number): Promise<EncryptedSecret> {
  const trimmed = secret.trim();
  if (trimmed.length < 8) throw new Error('That does not look like an API key.');
  const pub = await crypto.subtle.importKey('jwk', publicJwk, RSA, false, ['encrypt']);
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dek, new TextEncoder().encode(trimmed));
  const rawDek = await crypto.subtle.exportKey('raw', dek);
  const wrapped = await crypto.subtle.encrypt(RSA, pub, rawDek);
  return { ciphertext: b64(ct), wrapped_dek: b64(wrapped), iv: b64(iv), vault_key_version: keyVersion, last4: trimmed.slice(-4) };
}

/** API Worker side only. */
export async function decryptSecret(rec: { ciphertext: string | Uint8Array; wrapped_dek: string | Uint8Array; iv: string | Uint8Array }, privateJwk: JsonWebKey): Promise<string> {
  const bytes = (x: string | Uint8Array) => (typeof x === 'string' ? unb64(x) : x);
  const priv = await crypto.subtle.importKey('jwk', privateJwk, RSA, false, ['decrypt']);
  const rawDek = await crypto.subtle.decrypt(RSA, priv, bytes(rec.wrapped_dek) as BufferSource);
  const dek = await crypto.subtle.importKey('raw', rawDek, { name: 'AES-GCM' }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(rec.iv) as BufferSource }, dek, bytes(rec.ciphertext) as BufferSource);
  return new TextDecoder().decode(pt);
}

/** Re-wraps a data key for a new vault key pair (rotation runbook) without exposing the secret to the admin plane. */
export async function rewrap(rec: { wrapped_dek: string | Uint8Array }, oldPrivateJwk: JsonWebKey, newPublicJwk: JsonWebKey): Promise<string> {
  const bytes = (x: string | Uint8Array) => (typeof x === 'string' ? unb64(x) : x);
  const priv = await crypto.subtle.importKey('jwk', oldPrivateJwk, RSA, false, ['decrypt']);
  const rawDek = await crypto.subtle.decrypt(RSA, priv, bytes(rec.wrapped_dek) as BufferSource);
  const pub = await crypto.subtle.importKey('jwk', newPublicJwk, RSA, false, ['encrypt']);
  return b64(await crypto.subtle.encrypt(RSA, pub, rawDek));
}

export { b64 as toBase64 };
