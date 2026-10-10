/** UUIDv7 (time-ordered), generated in the application as database-design.md §3 requires. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random URL-safe token (for refresh tokens, idempotency keys, etc.). */
export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unambiguous alphabet for human-typed codes (no 0/O/1/I/L), admin-panel.md §7.2. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length = 10, alphabet = CODE_ALPHABET): string {
  const out: string[] = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    const b = new Uint8Array(length * 2);
    globalThis.crypto.getRandomValues(b);
    for (const x of b) {
      if (x < max && out.length < length) out.push(alphabet[x % alphabet.length]!);
    }
  }
  return out.join('');
}

/** Six-digit numeric OTP, uniformly distributed (values in the incomplete last block are redrawn, no modulo bias). */
export function randomOtp(): string {
  const limit = 4_294_000_000; // largest multiple of 1e6 below 2^32
  const b = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(b);
  while (b[0]! >= limit);
  return String(b[0]! % 1_000_000).padStart(6, '0');
}
