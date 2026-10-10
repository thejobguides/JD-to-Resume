import { sha256Hex } from '@jmo/shared';

// Small crypto helpers (WebCrypto only, so this runs in Node and Workers).

const enc = new TextEncoder();

async function aesKey(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(material));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts a JSON value for the transient optimization mailbox (≤ 24 h). */
export async function sealJson(value: unknown, keyMaterial: string, aad: string): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(keyMaterial);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)));
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function openJson<T>(iv: Uint8Array, ciphertext: Uint8Array, keyMaterial: string, aad: string): Promise<T> {
  const key = await aesKey(keyMaterial);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, ciphertext as BufferSource);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

/** Salted hash for IPs and refresh tokens (never stored raw). */
export async function saltedHash(value: string, salt: string): Promise<Uint8Array> {
  const hex = await sha256Hex(`${salt}:${value}`);
  return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

export async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Development CORS: http://localhost or http://127.0.0.1 on any port, matched exactly (not "localhost.attacker.com"). */
export function isLocalDevOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.pathname === '/' && !u.username;
  } catch {
    return false;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
