import type { PublicConfig } from '@jmo/shared';
import { EXTENSION_MIN_VERSION, sha256Hex } from '@jmo/shared';
import type { Namespace, NamespaceData } from './namespaces';

export type ActiveConfig = { [N in Namespace]: NamespaceData<N> };
export interface ActiveVersion {
  id: string;
  namespace: Namespace;
  version: number;
}

/** 'cs_' + 12 hex of SHA-256 over the sorted active version ids (admin-panel.md §6.4). */
export async function snapshotId(versionIds: string[]): Promise<string> {
  return `cs_${(await sha256Hex([...versionIds].sort().join(','))).slice(0, 12)}`;
}

/** The data-only config the extension receives (api-design.md §6.1). */
export function buildPublicConfig(c: ActiveConfig, meta: { version: number; snapshot: string }): PublicConfig {
  const now = Date.now();
  return {
    version: meta.version,
    config_snapshot: meta.snapshot,
    min_extension_version: EXTENSION_MIN_VERSION,
    scoring_version: c.scoring.version,
    kill_switches: { hosted_ai: c.kill_switches.hosted_ai, checkout: c.kill_switches.checkout, coupons: c.kill_switches.coupons },
    announcements: c.announcements.items.filter((a) => !a.until || Date.parse(a.until) > now),
    features: Object.fromEntries(Object.entries(c.features.flags).map(([k, v]) => [k, v.enabled])),
    extractors: c.extraction.adapters.map((a) => ({ ...a, enabled: a.enabled && c.kill_switches.portals[a.id] !== true })),
    limits: { jd_max_chars: c.extraction.jd_max_chars, resume_max_pages: c.limits.resume_max_pages },
  };
}

// ── Ed25519 signing of the public config (security-threat-model.md #20) ──

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Canonical JSON (sorted keys) so signatures are stable across runtimes. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export async function signConfig(config: PublicConfig, privateJwk: JsonWebKey, keyId: string): Promise<{ config: PublicConfig; signature: string; key_id: string }> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(canonicalJson(config)));
  return { config, signature: b64(sig), key_id: keyId };
}

export async function verifyConfig(signed: { config: PublicConfig; signature: string }, publicJwk: JsonWebKey): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(signed.signature) as BufferSource, new TextEncoder().encode(canonicalJson(signed.config)));
  } catch {
    return false;
  }
}

export async function generateSigningKeys(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', kp.publicKey) };
}

/** Changed paths between two config documents (admin diff preview). */
export function diffPaths(a: unknown, b: unknown, prefix = ''): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (x: unknown) => x && typeof x === 'object' && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].flatMap((k) => diffPaths((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
  }
  return [{ path: prefix || '(root)', before: a, after: b }];
}
