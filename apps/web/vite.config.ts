import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Content Security Policy for the production build, as a meta tag so it works on any static host. It limits scripts
// to this site and Google's sign-in button, and network calls to our API: an injected script could otherwise read
// the session token from sessionStorage. The dev server injects inline scripts for hot reload, so build only.
function csp(apiOrigin: string): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self' https://accounts.google.com/gsi/client",
    "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
    `connect-src 'self' ${apiOrigin} https://accounts.google.com/gsi/`,
    'frame-src https://accounts.google.com/gsi/',
    "img-src 'self' data: https://*.googleusercontent.com",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return { name: 'jmo-csp', apply: 'build', transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`) };
}

export default defineConfig(({ mode }) => {
  const api = process.env.VITE_API_URL ?? loadEnv(mode, '../..', 'VITE_').VITE_API_URL ?? 'http://localhost:8787';
  return {
    plugins: [react(), tailwind(), csp(new URL(api).origin)],
    // One .env at the repo root; only VITE_* values reach the browser bundle.
    envDir: '../..',
    // The Google OAuth client ID is public; one variable serves the API, the extension and this site.
    envPrefix: ['VITE_', 'GOOGLE_OAUTH_CLIENT_ID'],
    server: { port: 5175, strictPort: true },
  };
});
