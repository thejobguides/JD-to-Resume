import { type ActiveConfig, buildPublicConfig, defaultConfig, NAMESPACES, type Namespace, signConfig, snapshotId } from '@jmo/config';
import type { Sql } from '@jmo/db';
import type { PublicConfig, SignedConfig } from '@jmo/shared';

// Reads the active config versions (Postgres = source of truth; admin-panel.md §6.4). Cached in memory with a
// short TTL (the Workers deployment publishes the same documents to KV). Invalidated on activation.

export interface LoadedConfig {
  env: string;
  config: ActiveConfig;
  versions: Record<Namespace, { id: string; version: number }>;
  snapshot: string;
  version: number; // max version across namespaces, used as the public config version
  loadedAt: number;
}

export class ConfigStore {
  private cache: LoadedConfig | null = null;
  private signed: { snapshot: string; value: SignedConfig } | null = null;
  private inflight: Promise<LoadedConfig> | null = null;

  constructor(
    private sql: Sql,
    private env: 'production' | 'eval' = 'production',
    private ttlMs = 30_000,
  ) {}

  invalidate() {
    this.cache = null;
    this.signed = null;
  }

  async get(): Promise<LoadedConfig> {
    if (this.cache && Date.now() - this.cache.loadedAt < this.ttlMs) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<LoadedConfig> {
    const rows = await this.sql<Array<{ id: string; namespace: Namespace; version: number; data: unknown }>>`
      SELECT id, namespace, version, data FROM config_versions WHERE env = ${this.env} AND status = 'active'`;
    const fallback = defaultConfig({ useMockAi: true });
    const config = {} as Record<Namespace, unknown>;
    const versions = {} as Record<Namespace, { id: string; version: number }>;
    for (const ns of NAMESPACES) {
      const r = rows.find((x) => x.namespace === ns);
      config[ns] = r ? r.data : fallback[ns];
      versions[ns] = r ? { id: r.id, version: r.version } : { id: `default:${ns}`, version: 0 };
    }
    const ids = Object.values(versions).map((v) => v.id);
    const snapshot = await snapshotId(ids);
    await this.sql`INSERT INTO config_snapshots (id, env, version_ids) VALUES (${snapshot}, ${this.env}, ${ids.filter((i) => !i.startsWith('default:'))}) ON CONFLICT (id) DO NOTHING`;
    this.cache = {
      env: this.env,
      config: config as ActiveConfig,
      versions,
      snapshot,
      version: Math.max(...Object.values(versions).map((v) => v.version)),
      loadedAt: Date.now(),
    };
    return this.cache;
  }

  /** Signed, data-only config for the extension (GET /v1/config). */
  async publicSigned(privateJwk: JsonWebKey | undefined, keyId: string, extra: { announcements?: PublicConfig['announcements'] } = {}): Promise<SignedConfig> {
    const c = await this.get();
    if (this.signed && this.signed.snapshot === c.snapshot) return this.signed.value;
    const built = buildPublicConfig(c.config, { version: c.version, snapshot: c.snapshot });
    const pub = extra.announcements?.length ? { ...built, announcements: [...extra.announcements, ...built.announcements] } : built;
    const value = privateJwk ? await signConfig(pub, privateJwk, keyId) : { config: pub, signature: '', key_id: 'unsigned-dev' };
    this.signed = { snapshot: c.snapshot, value };
    return value;
  }
}
