import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Plain Vite multi-entry build for the MV3 extension (side panel, options page, service worker). The manifest is
// generated here so the version, API origin and signing key come from one place.

const here = import.meta.dirname;
const root = resolve(here, '../..');
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8')) as { version: string };

function configPublicKey(env: Record<string, string>): string {
  if (env.CONFIG_PUBLIC_KEY_JWK) return env.CONFIG_PUBLIC_KEY_JWK;
  // Development: the API writes its signing keys to .dev/keys.json on first start.
  const dev = resolve(root, '.dev/keys.json');
  if (existsSync(dev)) return JSON.stringify((JSON.parse(readFileSync(dev, 'utf8')) as { signing: { publicJwk: unknown } }).signing.publicJwk);
  console.warn('[extension] No config signing key (CONFIG_PUBLIC_KEY_JWK or .dev/keys.json): remote config will be ignored. Start the API once, then rebuild.');
  return '';
}

// Development builds use a fixed public key so the unpacked extension always gets the same ID
// (hbbojlpbahndpodjekcjheebjlhjiobd). Google sign-in needs that ID in its redirect URL. Store builds get their
// ID from the Chrome Web Store instead; a production build shared outside the store (EXTENSION_KEY) gets a fixed ID
// so the API can allow it in EXTENSION_ORIGINS.
const DEV_KEY = readFileSync(resolve(here, 'dev-extension-key.txt'), 'utf8').trim();

function manifest(mode: string, apiUrl: string, e2e: boolean, key: string): Plugin {
  const dev = mode === 'development';
  return {
    name: 'jmo-manifest',
    generateBundle() {
      const m = {
        manifest_version: 3,
        name: dev ? 'Job Match Optimizer (dev)' : 'Job Match Optimizer',
        description: 'Tailor your resume to a job posting without inventing anything. Your resume stays on your device.',
        version: pkg.version,
        ...(dev ? { key: DEV_KEY } : key ? { key } : {}),
        // Ed25519 in WebCrypto (signed config) needs Chrome 137+.
        minimum_chrome_version: '138',
        icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
        action: { default_title: 'Open Job Match Optimizer', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
        side_panel: { default_path: 'sidepanel.html' },
        options_page: 'options.html',
        background: { service_worker: 'background.js', type: 'module' },
        // identity: "Continue with Google" via launchWebAuthFlow (no install warning; we don't request identity.email).
        permissions: ['activeTab', 'scripting', 'sidePanel', 'storage', 'unlimitedStorage', 'contextMenus', 'identity'],
        // E2E builds can read the local fixture server without a toolbar click (activeTab can't be automated).
        host_permissions: [`${new URL(apiUrl).origin}/*`, ...(e2e ? ['http://127.0.0.1/*'] : [])],
        // Asked for one site at a time, only when "Analyze this page" can't use activeTab; BYOK hosts when a key is added.
        optional_host_permissions: ['https://*/*', 'http://*/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*'],
        externally_connectable: { ids: [] },
        content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';" },
        commands: { _execute_action: { suggested_key: { default: 'Alt+J' }, description: 'Open the side panel' } },
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(m, null, 2) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env } as Record<string, string>;
  const apiUrl = env.EXTENSION_API_URL || (mode === 'development' ? 'http://localhost:8787' : 'https://api.jobmatch.example');
  const webUrl = env.EXTENSION_WEB_URL || (mode === 'development' ? 'http://localhost:5175' : 'https://jobmatch.example');
  return {
    plugins: [react(), tailwind(), manifest(mode, apiUrl, env.EXTENSION_E2E === '1', env.EXTENSION_KEY ?? '')],
    define: {
      __API_URL__: JSON.stringify(apiUrl),
      __WEB_URL__: JSON.stringify(webUrl),
      __CONFIG_PUBLIC_KEY__: JSON.stringify(configPublicKey(env)),
      __EXT_VERSION__: JSON.stringify(pkg.version),
      // Public OAuth client ID (not a secret). Empty = the Google button is hidden.
      __GOOGLE_CLIENT_ID__: JSON.stringify((env.GOOGLE_OAUTH_CLIENT_ID ?? '').split(',')[0]!.trim()),
      // Development only: E2E tests point this at a stand-in identity provider.
      __GOOGLE_AUTH_URL__: JSON.stringify((mode === 'development' && env.EXTENSION_GOOGLE_AUTH_URL) || 'https://accounts.google.com/o/oauth2/v2/auth'),
    },
    build: {
      outDir: env.EXTENSION_OUT_DIR || (mode === 'development' ? 'dist-dev' : 'dist'),
      emptyOutDir: true,
      target: 'chrome138',
      sourcemap: mode === 'development',
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        input: { sidepanel: resolve(here, 'sidepanel.html'), options: resolve(here, 'options.html'), background: resolve(here, 'src/background.ts') },
        output: { entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js') },
      },
    },
  };
});
