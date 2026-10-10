import postgres from 'postgres';

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;
export type Db = Sql | Tx;

/** One pool per process (Node) or per request via Hyperdrive (Workers). */
export function createSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
    types: { bigint: postgres.BigInt },
    transform: { undefined: null },
  }) as unknown as Sql;
}

export { postgres };
