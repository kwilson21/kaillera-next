// Virtual Gamepad — comprehensive device resolution test
// Uses Playwright's built-in device descriptors for accurate viewports
// Run: node tests/vgp-device-test.mjs

import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { TEST_DEVICES } from './vgp-devices.js';

const SCREENSHOT_DIR = path.join(process.cwd(), 'tests', 'vgp-screenshots');
const URL = 'http://127.0.0.1:18888/tests/vgp-test.html';

async function run() {
  // Clean output
  if (fs.existsSync(SCREENSHOT_DIR)) fs.rmSync(SCREENSHOT_DIR, { recursive: true });
  for (const d of ['phone', 'tablet']) fs.mkdirSync(path.join(SCREENSHOT_DIR, d), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ hasTouch: true, isMobile: true });
  const page = await context.newPage();

  const results = [];
  let count = 0;
  const total = TEST_DEVICES.length * 4; // landscape+portrait × with/without chrome

  for (const [name, chrome, cat, customViewport] of TEST_DEVICES) {
    const desc = devices[name];
    const viewport = customViewport || desc?.viewport;
    if (!viewport) {
      console.warn(`Skip: ${name}`);
      continue;
    }

    for (const orient of ['landscape', 'portrait']) {
      for (const withChrome of [true, false]) {
        count++;
        let w, h;
        if (orient === 'portrait') {
          w = viewport.width;
          h = viewport.height - (withChrome ? chrome : 0);
        } else {
          w = viewport.height;
          h = viewport.width - (withChrome ? chrome : 0);
        }
        if (h < 200) h = 200;
        if (w < 300) w = 300;

        const chromeLabel = withChrome ? 'with_browser' : 'full_viewport';
        const label = `${name} ${orient} ${w}×${h} (${chromeLabel})`;

        await page.setViewportSize({ width: w, height: h });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.evaluate((t) => {
          const e = document.getElementById('device-label');
          if (e) e.textContent = t;
        }, label);
        await page.waitForTimeout(150);

        const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
        const filename = `${cat}/${safeName}__${orient}__${chromeLabel}.png`;
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), type: 'png' });
        results.push({ label, filepath: filename, cat, orient, chromeLabel });
        process.stdout.write(`\r[${count}/${total}] ${label}                    `);
      }
    }
  }

  // Generate HTML index
  const section = (title, items) => `
<h2>${title}</h2>
<div class="grid">${items.map((r) => `<div class="card"><img src="${r.filepath}" loading="lazy"/><div class="label">${r.label}</div></div>`).join('')}</div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>VGP Device Test</title>
<style>
body{background:#111;color:#eee;font-family:sans-serif;padding:20px}
h1{color:#6af}h2{color:#aaa;margin-top:30px;border-bottom:1px solid #333;padding-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(500px,1fr));gap:12px;margin-top:12px}
.card{background:#1a1a2e;border-radius:8px;overflow:hidden}
.card img{width:100%;display:block}
.card .label{padding:6px 10px;font-size:11px;color:#888;font-family:monospace}
</style></head><body>
<h1>Virtual Gamepad — Device Test (${new Date().toISOString().split('T')[0]})</h1>
<p>${results.length} screenshots across ${TEST_DEVICES.length} devices</p>
${section(
  'Phones — Landscape (with browser chrome)',
  results.filter((r) => r.cat === 'phone' && r.orient === 'landscape' && r.chromeLabel === 'with_browser'),
)}
${section(
  'Phones — Landscape (full viewport)',
  results.filter((r) => r.cat === 'phone' && r.orient === 'landscape' && r.chromeLabel === 'full_viewport'),
)}
${section(
  'Phones — Portrait',
  results.filter((r) => r.cat === 'phone' && r.orient === 'portrait' && r.chromeLabel === 'with_browser'),
)}
${section(
  'Tablets — Landscape (with browser chrome)',
  results.filter((r) => r.cat === 'tablet' && r.orient === 'landscape' && r.chromeLabel === 'with_browser'),
)}
${section(
  'Tablets — Landscape (full viewport)',
  results.filter((r) => r.cat === 'tablet' && r.orient === 'landscape' && r.chromeLabel === 'full_viewport'),
)}
${section(
  'Tablets — Portrait',
  results.filter((r) => r.cat === 'tablet' && r.orient === 'portrait' && r.chromeLabel === 'with_browser'),
)}
</body></html>`;

  fs.writeFileSync(path.join(SCREENSHOT_DIR, 'index.html'), html);
  await browser.close();
  console.log(`\n\nDone! ${results.length} screenshots → ${SCREENSHOT_DIR}/index.html`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
