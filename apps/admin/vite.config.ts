import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// Content Security Policy for the production build (meta tag; build only, the dev server needs inline scripts).
// The admin panel loads nothing from third parties and talks only to the admin API, so the policy is strict: an
// injected script can't load code or send the admin session token anywhere else.
function csp(apiOrigin: string): Plugin {
  const policy = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", `connect-src 'self' ${apiOrigin}`, "img-src 'self' data: blob:", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'"].join('; ');
  return { name: 'jmo-csp', apply: 'build', transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`) };
}

export default defineConfig(({ mode }) => {
  const api = process.env.VITE_ADMIN_API_URL ?? loadEnv(mode, '../..', 'VITE_').VITE_ADMIN_API_URL ?? 'http://localhost:8788';
  return {
    plugins: [react(), tailwind(), csp(new URL(api).origin)],
    // One .env at the repo root; only VITE_* values reach the browser bundle.
    envDir: '../..',
    server: { port: 5174, strictPort: true },
  };
});
