import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, resolve } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// System E2E: builds the extension, the website and the admin SPA, and starts what they talk to — the API (mock AI,
// fake Stripe) and the admin API on a dedicated database, plus a local "job site" serving the extraction fixtures.
// The website is the real checkout/account origin, so payments and account settings are tested through its UI.

export const ROOT = resolve(import.meta.dirname, '../../..');
export const API = 'http://localhost:8797';
export const SITE = 'http://127.0.0.1:8799';
export const EXT_DIR = resolve(ROOT, '.e2e/extension');
export const ADMIN = 'http://localhost:5184';
export const WEB = 'http://localhost:5185';
export const ADMIN_API = 'http://localhost:8796';
const ADMIN_DIR = resolve(ROOT, '.e2e/admin');
const WEB_DIR = resolve(ROOT, '.e2e/web');
const DB_URL = 'postgres://jmo:jmo@localhost:54329/jmo_e2e';
// Stand-in for Google's sign-in endpoint (real Google can't be automated). The API trusts it only outside production.
export const IDP = 'http://127.0.0.1:8795';
export const GOOGLE_CLIENT = 'e2e-client.apps.googleusercontent.com';
export const GOOGLE_USER = { sub: 'e2e-google-sub-1', email: 'gia.google@example.org', name: 'Gia Google' };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const FIXTURES: Record<string, string> = {
  '/jobs/lever': 'lever-jsonld.html',
  '/jobs/greenhouse': 'greenhouse-no-jsonld.html',
  '/jobs/noisy': 'generic-noisy-injection.html',
  '/jobs/stale': 'stale-jsonld.html',
};

async function waitFor(url: string, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup() {
  const pnpmEnv = { ...process.env, FORCE_COLOR: '0' };
  execFileSync('pnpm', ['exec', 'tsx', 'apps/extension/e2e/prepare.ts'], { cwd: ROOT, stdio: 'inherit', env: pnpmEnv });
  execFileSync('pnpm', ['--filter', '@jmo/extension', 'exec', 'vite', 'build', '--mode', 'development', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...pnpmEnv, EXTENSION_E2E: '1', EXTENSION_OUT_DIR: EXT_DIR, EXTENSION_API_URL: API, EXTENSION_WEB_URL: WEB, GOOGLE_OAUTH_CLIENT_ID: GOOGLE_CLIENT, EXTENSION_GOOGLE_AUTH_URL: `${IDP}/authorize` },
  });

  execFileSync('pnpm', ['--filter', '@jmo/admin', 'exec', 'vite', 'build', '--outDir', ADMIN_DIR, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...pnpmEnv, VITE_ADMIN_API_URL: ADMIN_API },
  });
  // The Google button needs Google's script from the internet; the website is tested with email codes only.
  execFileSync('pnpm', ['--filter', '@jmo/web', 'exec', 'vite', 'build', '--outDir', WEB_DIR, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...pnpmEnv, VITE_API_URL: API, GOOGLE_OAUTH_CLIENT_ID: '' },
  });

  const api: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'apps/api/src/node.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ENV: 'development',
      DATABASE_URL: DB_URL,
      API_PORT: '8797',
      WEB_ORIGIN: WEB,
      GOOGLE_OAUTH_CLIENT_ID: GOOGLE_CLIENT,
      GOOGLE_ISSUER_OVERRIDE: IDP,
      GOOGLE_JWKS_URL_OVERRIDE: `${IDP}/jwks`,
      OPENAI_API_KEY: '',
      STRIPE_SECRET_KEY: '',
    },
  });

  const adminApi: ChildProcess = spawn('pnpm', ['exec', 'tsx', 'apps/admin-api/src/node.ts'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, NODE_ENV: 'development', ENV: 'development', DATABASE_URL: DB_URL, ADMIN_API_PORT: '8796', PUBLIC_API_URL: API, WEB_ORIGIN: WEB, STRIPE_SECRET_KEY: '' },
  });

  // Static SPAs with history fallback (served on "localhost" so the dev CORS rule admits them).
  const spa = (dir: string): Server =>
    createServer((req, res) => {
      const path = resolve(dir, `.${(req.url ?? '/').split('?')[0]}`);
      const file = path.startsWith(dir) && existsSync(path) && extname(path) ? path : resolve(dir, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    });
  const adminSite = spa(ADMIN_DIR);
  await new Promise<void>((r) => adminSite.listen(5184, 'localhost', r));
  const webSite = spa(WEB_DIR);
  await new Promise<void>((r) => webSite.listen(5185, 'localhost', r));

  // Minimal OpenID provider: /authorize immediately redirects back with a signed ID token for GOOGLE_USER.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'e2e', alg: 'RS256', use: 'sig' };
  const idp: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', IDP);
    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [jwk] }));
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const token = await new SignJWT({ email: GOOGLE_USER.email, email_verified: true, name: GOOGLE_USER.name, nonce: q.get('nonce') })
        .setProtectedHeader({ alg: 'RS256', kid: 'e2e' })
        .setIssuer(IDP)
        .setAudience(q.get('client_id')!)
        .setSubject(GOOGLE_USER.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      res.writeHead(302, { location: `${q.get('redirect_uri')}#${new URLSearchParams({ id_token: token, state: q.get('state') ?? '' })}` });
      return res.end();
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => idp.listen(8795, '127.0.0.1', r));

  const site: Server = createServer((req, res) => {
    const file = FIXTURES[(req.url ?? '').split('?')[0]!];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(file ? readFileSync(resolve(ROOT, 'tests/fixtures/jd', file)) : `<!doctype html><title>Test site</title><p>${req.url}</p>`);
  });
  await new Promise<void>((r) => site.listen(8799, '127.0.0.1', r));
  await waitFor(`${API}/v1/health`);
  await waitFor(`${ADMIN_API}/admin/v1/health`);

  return async () => {
    api.kill('SIGTERM');
    adminApi.kill('SIGTERM');
    await new Promise<void>((r) => site.close(() => r()));
    await new Promise<void>((r) => adminSite.close(() => r()));
    await new Promise<void>((r) => webSite.close(() => r()));
    await new Promise<void>((r) => idp.close(() => r()));
  };
}
