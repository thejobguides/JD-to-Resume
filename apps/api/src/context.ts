import type { Sql } from '@jmo/db';
import type { AccessClaims, AiRuntime, AuthService, BillingService, ConfigStore, Mailer, OptimizationRunner, ServerEnv } from '@jmo/server';

export interface Deps {
  sql: Sql;
  env: ServerEnv;
  config: ConfigStore;
  auth: AuthService;
  ai: AiRuntime;
  runner: OptimizationRunner;
  billing: BillingService;
  mailer: Mailer;
  now?: () => Date;
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    requestId: string;
    user: AccessClaims | null;
  };
};
