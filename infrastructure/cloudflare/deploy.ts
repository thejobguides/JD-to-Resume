// Production deploy: pnpm deploy:prod [init|db|deploy|apis|sites|extension]  (no argument = all, in that order).
//
//   init       Creates .env.production (git-ignored): generated secrets plus values copied from .env. Never
//              overwrites a value that is already there; those keys must stay stable (see below).
//   db         Migrates and seeds the production database, then creates Stripe test prices for it.
//   deploy     apis + sites.
//   apis       Stripe webhook endpoint and the two Node APIs, on Render (API_HOST=render, the default: free web
//              services built from the GitHub repo, RENDER_API_KEY) or Cloudflare Containers (API_HOST=cloudflare,
//              Workers Paid plan, Docker running locally).
//   sites      The website and the admin panel as static Workers on Cloudflare (any plan).
//   extension  Builds the extension for the deployed API and zips it for sharing or the Chrome Web Store.
//
// Cloudflare steps need Node 22+ (wrangler) and `pnpm --filter @jmo/cloudflare exec wrangler login`.
// Addresses: website and admin panel https://jmo-{web,admin}.<WORKERS_SUBDOMAIN>.workers.dev; the APIs at their
// Render addresses (saved as API_URL and ADMIN_API_URL) or https://jmo-{api,admin-api}.<WORKERS_SUBDOMAIN>.workers.dev.

import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateSigningKeys } from '@jmo/config';
import { createSql, migrate, seed } from '@jmo/db';
import { generateVaultKeyPair } from '@jmo/vault';

const HERE = import.meta.dirname;
const ROOT = resolve(HERE, '../..');
const PROD = resolve(ROOT, '.env.production');
const STRIPE_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'];

type Env = Record<string, string>;

function readEnv(path: string): Env {
  if (!existsSync(path)) return {};
  const out: Env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === "'" || q === '"') && v.endsWith(q) && v.length > 1) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (v) out[m[1]!] = v;
  }
  return out;
}

/** Sets keys in .env.production: replaces an existing line, appends a new one. */
function save(values: Env) {
  if (!Object.keys(values).length) return;
  const lines = existsSync(PROD) ? readFileSync(PROD, 'utf8').replace(/\n*$/, '').split('\n') : ['# Production settings for `pnpm deploy:prod`. Secret: never commit or share this file.'];
  for (const [k, v] of Object.entries(values)) {
    const at = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (at >= 0) lines[at] = `${k}='${v}'`;
    else lines.push(`${k}='${v}'`);
  }
  writeFileSync(PROD, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// Child processes get this process's Node first on PATH, so the Node 22 running this script also runs wrangler.
function run(cmd: string, args: string[], extra: Env = {}, cwd = ROOT) {
  const env = { ...process.env, ...extra, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (exit ${r.status})`);
}

function wrangler(config: string, vars: Env = {}, secrets: Env = {}, flags: string[] = []) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error(`Wrangler needs Node 22+; this is Node ${process.versions.node}.`);
  const args = ['exec', 'wrangler', 'deploy', '-c', resolve(HERE, config), ...flags];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const dir = mkdtempSync(join(tmpdir(), 'jmo-secrets-'));
  try {
    if (Object.keys(secrets).length) {
      writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });
      args.push('--secrets-file', join(dir, 'secrets.json'));
    }
    run('pnpm', args, {}, HERE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pick = (env: Env, keys: string[]) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]!]));
const onRender = (env: Env) => (env.API_HOST ?? 'render') === 'render';

/** Chrome derives an unpacked extension's ID from the manifest key: SHA-256 of the key, first 32 hex digits as a–p. */
const extensionId = (key: string) => [...createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

function urls(env: Env) {
  if (!env.WORKERS_SUBDOMAIN) throw new Error('Set WORKERS_SUBDOMAIN in .env.production (the part before .workers.dev in Workers & Pages → Settings).');
  const at = (name: string) => `https://${name}.${env.WORKERS_SUBDOMAIN}.workers.dev`;
  if (onRender(env) && !(env.API_URL && env.ADMIN_API_URL)) throw new Error('The Render services do not exist yet: run `pnpm deploy:prod apis` first.');
  return {
    api: onRender(env) ? env.API_URL! : at('jmo-api'),
    adminApi: onRender(env) ? env.ADMIN_API_URL! : at('jmo-admin-api'),
    web: at('jmo-web'),
    admin: at('jmo-admin'),
  };
}

function need(env: Env, keys: string[]) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing in .env.production: ${missing.join(', ')}`);
}

async function init() {
  const have = readEnv(PROD);
  const dev = readEnv(resolve(ROOT, '.env'));
  const add: Env = {};
  const set = (k: string, v: string | undefined) => {
    if (!have[k] && v) add[k] = v;
  };
  set('DATABASE_URL', dev.PROD_DATABASE_URL);
  for (const k of ['STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'RENDER_API_KEY']) set(k, dev[k]);
  // Generated once. Replacing them later signs everyone out (JWT_SECRET) or makes stored data unreadable (the
  // encryption keys and the vault key pair), so they are never regenerated while present.
  for (const k of ['JWT_SECRET', 'INTERNAL_TOKEN', 'MAILBOX_KEY', 'CONTENT_ENCRYPTION_KEY']) set(k, randomBytes(48).toString('base64url'));
  if (!have.VAULT_PRIVATE_KEY_JWK) {
    const v = await generateVaultKeyPair();
    Object.assign(add, { VAULT_PUBLIC_KEY_JWK: JSON.stringify(v.publicJwk), VAULT_PRIVATE_KEY_JWK: JSON.stringify(v.privateJwk) });
  }
  if (!have.CONFIG_SIGNING_PRIVATE_KEY_JWK) {
    const s = await generateSigningKeys();
    Object.assign(add, { CONFIG_SIGNING_PRIVATE_KEY_JWK: JSON.stringify(s.privateJwk), CONFIG_PUBLIC_KEY_JWK: JSON.stringify(s.publicJwk) });
  }
  if (!have.EXTENSION_KEY) set('EXTENSION_KEY', generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
  save(add);
  console.log(`.env.production: ${Object.keys(add).length ? `added ${Object.keys(add).join(', ')}` : 'nothing new'}.`);
  const env = readEnv(PROD);
  const todo = ['WORKERS_SUBDOMAIN', 'DATABASE_URL', 'EMAIL_FROM', 'ADMIN_OWNER_EMAIL', 'STRIPE_SECRET_KEY', 'RESEND_API_KEY', 'OPENAI_API_KEY', ...(onRender(env) ? ['RENDER_API_KEY'] : [])].filter((k) => !env[k]);
  if (todo.length) console.log(`Still to fill in .env.production (or .env, then run init again): ${todo.join(', ')}`);
  if (env.EXTENSION_KEY) console.log(`Extension ID for this deployment: ${extensionId(env.EXTENSION_KEY)}`);
}

async function db(env: Env) {
  need(env, ['DATABASE_URL', 'ADMIN_OWNER_EMAIL', 'STRIPE_SECRET_KEY']);
  if (!env.OPENAI_API_KEY) console.warn('OPENAI_API_KEY is not set: AI features will fail until it is added and `apis` is run again.');
  const sql = createSql(env.DATABASE_URL!, { max: 1 });
  try {
    await migrate(sql);
    const [plans] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM plans`;
    // Always the real routing: the seed's routing stays in the config, and production must never answer with mock
    // output. Until OPENAI_API_KEY is set, AI features fail with an error; pricing, sign-in and checkout still work.
    if (!plans?.n) await seed(sql, { ownerEmail: env.ADMIN_OWNER_EMAIL!, useMockAi: false });
  } finally {
    await sql.end();
  }
  // Same script as `pnpm stripe:setup`, but with only these values (not the local .env). It refuses live keys, so
  // live prices go through Admin → Plans & pricing.
  run('pnpm', ['--filter', '@jmo/api', 'exec', 'tsx', 'src/scripts/stripe-setup.ts'], { DATABASE_URL: env.DATABASE_URL!, STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY! });
}

async function stripeWebhook(env: Env, apiUrl: string) {
  const url = `${apiUrl}/v1/webhooks/stripe`;
  if (env.STRIPE_WEBHOOK_SECRET && env.STRIPE_WEBHOOK_URL === url) return;
  const stripe = async (method: string, path: string, body?: URLSearchParams) => {
    const r = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, ...(body ? { body } : {}) });
    const j = (await r.json()) as { error?: { message: string } } & Record<string, unknown>;
    if (!r.ok) throw new Error(`Stripe ${path}: ${j.error?.message}`);
    return j;
  };
  const existing = (await stripe('GET', '/webhook_endpoints?limit=100')).data as Array<{ url: string }>;
  if (existing.some((e) => e.url === url)) throw new Error(`Stripe already has a webhook for ${url}, but its signing secret is not in .env.production. Copy it from Stripe (Developers → Webhooks) as STRIPE_WEBHOOK_SECRET, or delete that endpoint and run again.`);
  const body = new URLSearchParams({ url, description: 'Job Match Optimizer' });
  STRIPE_EVENTS.forEach((e, i) => body.append(`enabled_events[${i}]`, e));
  const created = await stripe('POST', '/webhook_endpoints', body);
  Object.assign(env, { STRIPE_WEBHOOK_SECRET: String(created.secret), STRIPE_WEBHOOK_URL: url });
  save({ STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET!, STRIPE_WEBHOOK_URL: url });
  console.log(`Stripe webhook endpoint created: ${url}`);
}

async function healthy(url: string) {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) return console.log(`✓ ${url}`);
    await new Promise((ok) => setTimeout(ok, 5_000));
  }
  throw new Error(`${url} did not become healthy in 5 minutes; check the service logs (Render or Cloudflare dashboard).`);
}

/** The two APIs' configuration: vars for both, secrets for both, and secrets only the public API may hold. */
function serviceEnv(env: Env, u: ReturnType<typeof urls>) {
  need(env, ['DATABASE_URL', 'JWT_SECRET', 'INTERNAL_TOKEN', 'MAILBOX_KEY', 'CONTENT_ENCRYPTION_KEY', 'VAULT_PUBLIC_KEY_JWK', 'VAULT_PRIVATE_KEY_JWK', 'CONFIG_SIGNING_PRIVATE_KEY_JWK', 'EXTENSION_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'EMAIL_FROM']);
  return {
    vars: {
      PUBLIC_API_URL: u.api,
      WEB_ORIGIN: u.web,
      ADMIN_ORIGIN: u.admin,
      EXTENSION_ORIGINS: [`chrome-extension://${extensionId(env.EXTENSION_KEY!)}`, ...(env.EXTRA_EXTENSION_ORIGINS ? [env.EXTRA_EXTENSION_ORIGINS] : [])].join(','),
      ...pick(env, ['EMAIL_FROM', 'CF_ACCESS_TEAM_DOMAIN', 'CF_ACCESS_AUD', 'ADMIN_ALLOW_WITHOUT_ACCESS', 'GOOGLE_OAUTH_CLIENT_ID']),
    },
    shared: pick(env, ['DATABASE_URL', 'JWT_SECRET', 'INTERNAL_TOKEN', 'MAILBOX_KEY', 'CONTENT_ENCRYPTION_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'VAULT_PUBLIC_KEY_JWK']),
    // Only the public API holds the vault private key, the config-signing key and the AI provider keys.
    apiOnly: pick(env, ['VAULT_PRIVATE_KEY_JWK', 'CONFIG_SIGNING_PRIVATE_KEY_JWK', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']),
  };
}

async function cloudflareApis(env: Env) {
  const u = urls(env);
  await stripeWebhook(env, u.api);
  const { vars, shared, apiOnly } = serviceEnv(env, u);
  const containers = ['--containers-rollout', 'immediate'];
  wrangler('api.jsonc', vars, { ...shared, ...apiOnly }, containers);
  wrangler('admin-api.jsonc', vars, shared, containers);
}

// ── Render ──

interface RenderService {
  id: string;
  name: string;
  url?: string;
  serviceDetails?: { url?: string };
}

// The Render region nearest the database, from the Neon host name (e.g. ep-xxx.ap-southeast-1.aws.neon.tech).
const REGIONS: Array<[RegExp, string]> = [
  [/us-west|westus/, 'oregon'],
  [/us-east-2/, 'ohio'],
  [/us-east-1|eastus/, 'virginia'],
  [/eu-|europe|germany|uk/, 'frankfurt'],
  [/ap-|asia|japan|australia|india/, 'singapore'],
];

async function renderApis(env: Env) {
  need(env, ['RENDER_API_KEY', 'DATABASE_URL']);
  const render = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`https://api.render.com/v1${path}`, { method, headers: { authorization: `Bearer ${env.RENDER_API_KEY}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`Render ${method} ${path.split('?')[0]}: ${r.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };

  // Render builds the Dockerfile from GitHub, so what runs is what is pushed.
  const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
  const repo = env.RENDER_REPO ?? git('remote', 'get-url', 'origin').replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
  const branch = env.RENDER_BRANCH ?? 'main';
  const unpushed = git('status', '--porcelain', '--', 'apps/api', 'apps/admin-api', 'packages', 'infrastructure/docker', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml');
  if (unpushed || git('rev-list', '--count', `origin/${branch}..HEAD`) !== '0') console.warn(`⚠ Render builds ${repo}@${branch}; the server code has changes that are not pushed there yet.`);

  const host = new URL(env.DATABASE_URL!).hostname;
  const region = env.RENDER_REGION ?? REGIONS.find(([re]) => re.test(host))?.[1] ?? 'oregon';
  const [first] = await render<Array<{ owner: { id: string; name: string } }>>('GET', '/owners?limit=20');
  const ownerId = env.RENDER_OWNER_ID ?? first?.owner.id;
  if (!ownerId) throw new Error('No Render workspace found for RENDER_API_KEY.');

  const ensure = async (name: string, app: string, healthCheckPath: string) => {
    const found = await render<Array<{ service: RenderService }>>('GET', `/services?name=${encodeURIComponent(name)}&ownerId=${ownerId}&limit=20`);
    let svc = found.map((f) => f.service).find((s) => s.name === name);
    if (!svc) {
      const created = await render<{ service: RenderService; deployId?: string }>('POST', '/services', {
        type: 'web_service',
        name,
        ownerId,
        repo,
        branch,
        autoDeploy: 'no',
        envVars: [{ key: 'APP', value: app }],
        serviceDetails: { runtime: 'docker', plan: env.RENDER_PLAN ?? 'free', region, healthCheckPath, envSpecificDetails: { dockerfilePath: './infrastructure/docker/Dockerfile', dockerContext: '.' } },
      });
      svc = created.service;
      // The first deploy would start without its settings; the real one follows once they are in.
      if (created.deployId) await render('POST', `/services/${svc.id}/deploys/${created.deployId}/cancel`).catch(() => undefined);
      console.log(`Render service created: ${name} (${region})`);
    }
    const url = svc.serviceDetails?.url ?? svc.url;
    if (!url) throw new Error(`Render did not report an address for ${name}.`);
    return { id: svc.id, url };
  };
  const api = await ensure('jmo-api', 'api', '/v1/health');
  const admin = await ensure('jmo-admin-api', 'admin-api', '/admin/v1/health');
  if (env.API_URL !== api.url || env.ADMIN_API_URL !== admin.url) {
    Object.assign(env, { API_URL: api.url, ADMIN_API_URL: admin.url });
    save({ API_URL: api.url, ADMIN_API_URL: admin.url });
  }

  const u = urls(env);
  await stripeWebhook(env, u.api);
  const { vars, shared, apiOnly } = serviceEnv(env, u);
  const asList = (e: Env) => Object.entries(e).map(([key, value]) => ({ key, value }));
  await render('PUT', `/services/${api.id}/env-vars`, asList({ APP: 'api', ...vars, ...shared, ...apiOnly }));
  await render('PUT', `/services/${admin.id}/env-vars`, asList({ APP: 'admin-api', ...vars, ...shared }));

  const deploy = async (svc: { id: string }, name: string) => {
    const d = await render<{ id: string }>('POST', `/services/${svc.id}/deploys`, { clearCache: 'do_not_clear' });
    let last = '';
    const until = Date.now() + 30 * 60_000;
    while (Date.now() < until) {
      const { status } = await render<{ status: string }>('GET', `/services/${svc.id}/deploys/${d.id}`);
      if (status !== last) console.log(`${name}: ${(last = status)}`);
      if (status === 'live') return;
      if (/failed|canceled|deactivated/.test(status)) throw new Error(`${name} deploy ${status}: see its logs at https://dashboard.render.com`);
      await new Promise((ok) => setTimeout(ok, 10_000));
    }
    throw new Error(`${name} deploy did not finish in 30 minutes.`);
  };
  await Promise.all([deploy(api, 'jmo-api'), deploy(admin, 'jmo-admin-api')]);
}

async function apis(env: Env) {
  if (onRender(env)) await renderApis(env);
  else await cloudflareApis(env);
  const u = urls(env);
  await healthy(`${u.api}/v1/health`);
  await healthy(`${u.adminApi}/admin/v1/health`);
  console.log(`API: ${u.api}\nAdmin API: ${u.adminApi}`);
}

// The website and the admin panel are static and need no paid plan; they only need the API addresses at build time.
function sites(env: Env) {
  const u = urls(env);
  run('pnpm', ['--filter', '@jmo/web', 'build'], { VITE_API_URL: u.api, ...pick(env, ['VITE_CHROME_STORE_URL']) });
  wrangler('web.jsonc');
  run('pnpm', ['--filter', '@jmo/admin', 'build'], { VITE_ADMIN_API_URL: u.adminApi });
  wrangler('admin.jsonc');
  console.log(`Website: ${u.web}\nAdmin panel: ${u.admin}`);
}

function extension(env: Env) {
  need(env, ['CONFIG_PUBLIC_KEY_JWK', 'EXTENSION_KEY']);
  const u = urls(env);
  run('pnpm', ['--filter', '@jmo/extension', 'build'], { EXTENSION_API_URL: u.api, EXTENSION_WEB_URL: u.web, CONFIG_PUBLIC_KEY_JWK: env.CONFIG_PUBLIC_KEY_JWK!, EXTENSION_KEY: env.EXTENSION_KEY!, ...pick(env, ['GOOGLE_OAUTH_CLIENT_ID']) });
  const version = (JSON.parse(readFileSync(resolve(ROOT, 'apps/extension/package.json'), 'utf8')) as { version: string }).version;
  const out = resolve(ROOT, 'apps/extension/release');
  const zip = join(out, `job-match-optimizer-${version}.zip`);
  mkdirSync(out, { recursive: true });
  rmSync(zip, { force: true });
  run('zip', ['-qr', zip, '.'], {}, resolve(ROOT, 'apps/extension/dist'));
  console.log(`Extension (ID ${extensionId(env.EXTENSION_KEY!)}): ${zip}`);
}

const step = process.argv[2] ?? 'all';
if (!['init', 'db', 'deploy', 'apis', 'sites', 'extension', 'all'].includes(step)) throw new Error(`Unknown step "${step}": use init, db, deploy (apis + sites), apis, sites or extension.`);
if (step === 'init' || step === 'all') await init();
const env = readEnv(PROD);
if (step === 'db' || step === 'all') await db(env);
if (['deploy', 'apis', 'all'].includes(step)) await apis(env);
if (['deploy', 'sites', 'all'].includes(step)) sites(env);
if (step === 'extension' || step === 'all') extension(env);
