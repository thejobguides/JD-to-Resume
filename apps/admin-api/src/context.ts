import type { Sql } from '@jmo/db';
import type { AuthService, BillingService, ConfigStore, PaymentGateway, ServerEnv } from '@jmo/server';

export interface AdminDeps {
  sql: Sql;
  env: ServerEnv;
  config: ConfigStore;
  auth: AuthService;
  billing: BillingService;
  payments: PaymentGateway;
  /** Calls the API's internal endpoints (a Cloudflare service binding in production). */
  internal: (path: string, body?: unknown) => Promise<unknown>;
}

export interface AdminUser {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'support' | 'finance' | 'analyst';
  sid: string;
}

export type AdminEnv = {
  Variables: {
    deps: AdminDeps;
    requestId: string;
    admin: AdminUser;
  };
};
