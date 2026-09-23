// Smoke-check a deployed demo: HTTPS, cross-origin isolation, ROM drop zone,
// no console errors, no failed requests.
//   node scripts/check_demo.mjs https://kaillera-next.thesuperhuman.us/
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://localhost:8787/';
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const errors = [];
const failed = [];
page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} @ ${m.location().url}`));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => r.status() >= 400 && failed.push(`${r.url()} ${r.status()}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const checks = {
  https: page.url().startsWith('https://') || url.startsWith('http://localhost'),
  crossOriginIsolated: await page.evaluate(() => crossOriginIsolated),
  romDropVisible: await page.locator('#rom-drop').isVisible(),
  noConsoleErrors: errors.length === 0,
  noFailedRequests: failed.length === 0,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
for (const e of errors) console.log(`  console: ${e}`);
for (const f of failed) console.log(`  request: ${f}`);
await browser.close();
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
