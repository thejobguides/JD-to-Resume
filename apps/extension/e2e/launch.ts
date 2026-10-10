import { chromium } from '@playwright/test';
import { EXT_DIR } from './global-setup';

// Chromium with the built extension in a fresh profile. A fresh profile is a fresh install, and on install the
// extension opens its settings tab. If a test opens options.html before that tab appears, Chrome reuses the test's
// tab for it and reloads it mid-step (a flaky failure in the first test after a cold start). So wait for the install
// tab and close it before handing the browser over.
export async function launchExtension(opts: { acceptDownloads?: boolean } = {}) {
  const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, ...opts, args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`] });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  const options = `chrome-extension://${extId}/options.html`;
  const until = Date.now() + 15_000;
  for (;;) {
    const opened = context.pages().find((p) => p.url().startsWith(options));
    if (opened) {
      await opened.close();
      break;
    }
    if (Date.now() > until) throw new Error('the extension did not open its settings tab on install');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { context, sw, extId };
}
