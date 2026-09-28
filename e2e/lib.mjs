// Helpers for quick UI checks against the browser test server (see scripts/build-test.mjs).
// Scripts that import this must live inside the repo (e.g. .build-test/<name>/check.mjs) so
// Node can resolve @playwright/test from node_modules.
import { chromium } from '@playwright/test';

export const OWNER = { username: 'owner', password: '1234' };

/** Call an API route on the test server. Throws on error. */
export async function api(base, name, input) {
  const res = await fetch(`${base}/api/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, input }) });
  const json = await res.json();
  if (!json.ok) throw new Error(`${name}: ${json.error.message}`);
  return json.data;
}

/** First-run setup (idempotent): business + owner "owner" / "1234", books from 1 April of the current FY. */
export async function ensureSetup(base, { booksStartDate, openingCash = 1000000 } = {}) {
  const status = await api(base, 'app.status');
  if (!status.setupDone) {
    const d = new Date();
    const fyStartYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    await api(base, 'setup.complete', {
      business: { name: 'Sharma General Store', address: '12 MG Road, Pune 411001', phone: '98200 12345' },
      owner: { fullName: 'Ravi Sharma', ...OWNER },
      booksStartDate: booksStartDate ?? `${fyStartYear}-04-01`,
      openingCash,
    });
  } else if (!status.session) {
    await api(base, 'auth.login', OWNER);
  }
}

/** Launch Chromium (pre-installed) and open the app. Collects console errors in page.errors. */
export async function openApp(base, path = '/') {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 }, locale: 'en-IN' });
  page.errors = [];
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(`${base}/#${path}`);
  await page.waitForLoadState('networkidle');
  return { browser, page };
}
