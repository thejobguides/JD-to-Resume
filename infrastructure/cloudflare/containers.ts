import { Container, getContainer } from '@cloudflare/containers';

// Cloudflare entry for the public API and the admin API (api.jsonc, admin-api.jsonc). The Worker forwards every
// request to ONE container running the Node server from infrastructure/docker/Dockerfile: live tailoring progress
// (SSE) lives in that process's memory, so requests must not be spread over several instances. Vars and secrets set
// on the Worker become the container's environment. The container sleeps when idle; the cron wakes it so the
// background jobs in node.ts (rollups, retention) still run.

interface Env {
  APP: DurableObjectNamespace<Container>;
}

// Workers vars and secrets are strings; bindings (the Durable Object namespace) are not and stay behind.
const strings = (env: object) => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));

export class ApiContainer extends Container<Env> {
  defaultPort = 8787;
  sleepAfter = '30m';
  enableInternet = true;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = strings(env);
  }
}

export class AdminApiContainer extends Container<Env> {
  defaultPort = 8788;
  sleepAfter = '30m';
  enableInternet = true;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = strings(env);
  }
}

export default {
  fetch: (request: Request, env: Env) => getContainer(env.APP, 'main').fetch(request),
  async scheduled(_controller: ScheduledController, env: Env) {
    await getContainer(env.APP, 'main').fetch(new Request('http://container/v1/health'));
  },
};
