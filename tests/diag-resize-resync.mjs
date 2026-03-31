// Diagnostic: UI resize + resync visual investigation
// Run: node tests/diag-resize-resync.mjs
import { chromium, devices } from 'playwright';
import fs from 'fs';
import path from 'path';

const OUT = path.join(process.cwd(), 'tests', 'diag-screenshots');
fs.mkdirSync(OUT, { recursive: true });

const BASE = 'http://localhost:27888';

const log = (msg) => console.log(`[diag] ${msg}`);

async function getLayoutInfo(page) {
  return page.evaluate(() => {
    const body = document.body;
    const game = document.getElementById('game');
    const vgp = document.getElementById('virtual-gamepad');
    const canvas = document.querySelector('canvas');
    const toolbar = document.getElementById('kn-toolbar');

    const cs = (el) => (el ? window.getComputedStyle(el) : null);
    const rect = (el) => (el ? el.getBoundingClientRect() : null);

    const bodyCS = cs(body);
    const gameCS = cs(game);
    const vgpCS = cs(vgp);

    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screenH: screen.height,
      // CSS units resolved
      bodyHeight: bodyCS?.height,
      bodyHeightPx: rect(body)?.height,
      gameDisplay: gameCS?.display,
      gameHeight: gameCS?.height,
      gameHeightPx: rect(game)?.height,
      gameFlexGrow: gameCS?.flexGrow,
      vgpExists: !!vgp,
      vgpHeight: vgpCS?.height,
      vgpHeightPx: rect(vgp)?.height,
      canvasExists: !!canvas,
      canvasWidth: canvas?.width,
      canvasHeight: canvas?.height,
      canvasStyleWidth: cs(canvas)?.width,
      canvasStyleHeight: cs(canvas)?.height,
      toolbarHeight: rect(toolbar)?.height,
      // Check for dvh/svh usage in inline styles or stylesheets
      dvhInBody: body.getAttribute('style')?.includes('dvh') ?? false,
    };
  });
}

async function injectResizeMonitor(page) {
  await page.evaluate(() => {
    window.__resizeLog = [];
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        window.__resizeLog.push({
          ts: performance.now(),
          id: el.id || el.tagName,
          cls: el.className?.slice?.(0, 40) ?? '',
          w: Math.round(e.contentRect.width),
          h: Math.round(e.contentRect.height),
        });
      }
    });
    // Observe the key elements
    for (const id of ['game', 'virtual-gamepad', 'kn-toolbar', 'kn-overlay']) {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    }
    const canvas = document.querySelector('canvas');
    if (canvas) obs.observe(canvas);
    document.body && obs.observe(document.body);
    window.__resizeObs = obs;
    console.log(
      '[resize-monitor] watching:',
      ['game', 'virtual-gamepad', 'kn-toolbar', 'kn-overlay', 'canvas', 'body'].map((id) =>
        id === 'canvas' ? !!document.querySelector('canvas') : !!document.getElementById(id),
      ),
    );
  });
}

async function getResizeLog(page) {
  return page.evaluate(() => window.__resizeLog ?? []);
}

async function injectEJSResizeMonitor(page) {
  // Patch EJS ResizeObserver to log calls
  await page.evaluate(() => {
    const OrigRO = window.ResizeObserver;
    window.ResizeObserver = class PatchedRO extends OrigRO {
      constructor(cb) {
        const wrapped = (entries, obs) => {
          for (const e of entries) {
            const el = e.target;
            const stack = new Error().stack?.split('\n').slice(2, 5).join(' | ');
            window.__resizeLog?.push({
              ts: performance.now(),
              id: el.id || el.tagName || 'unknown',
              cls: (el.className || '').slice(0, 40),
              w: Math.round(e.contentRect.width),
              h: Math.round(e.contentRect.height),
              source: 'external-ro',
              stack: stack?.slice(0, 150),
            });
          }
          return cb(entries, obs);
        };
        super(wrapped);
      }
    };
    window.ResizeObserver.prototype = OrigRO.prototype;
  });
}

async function checkStylesheets(page) {
  return page.evaluate(() => {
    const results = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules ?? []) {
          const text = rule.cssText ?? '';
          if (text.includes('dvh') || text.includes('100vh') || text.includes('100%')) {
            results.push({ href: sheet.href?.slice(-40) ?? 'inline', rule: text.slice(0, 120) });
          }
        }
      } catch (_) {
        /* cross-origin */
      }
    }
    return results;
  });
}

// ── Test 1: Initial layout at portrait iPhone 14 ──────────────────────────────
async function testPortraitLayout(browser) {
  log('\n=== TEST 1: Portrait mobile layout ===');
  const ctx = await browser.newContext({
    ...devices['iPhone 14'],
    hasTouch: true,
  });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    if (msg.text().includes('resize') || msg.text().includes('dvh') || msg.text().includes('canvas')) {
      log(`console: ${msg.text()}`);
    }
  });

  await page.goto(`${BASE}/play.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const layout1 = await getLayoutInfo(page);
  log('Initial layout:');
  log(JSON.stringify(layout1, null, 2));

  await page.screenshot({ path: path.join(OUT, '1a-portrait-initial.png') });

  // Check dvh/100vh in stylesheets
  const cssRules = await checkStylesheets(page);
  if (cssRules.length > 0) {
    log('\nCSS rules with dvh/100vh/100%:');
    cssRules.forEach((r) => log(`  [${r.href}] ${r.rule}`));
  }

  // Simulate address bar appearing (reduce height by 80px)
  log('\n-- Simulating address bar show (viewport shrinks 80px) --');
  await injectResizeMonitor(page);
  await page.evaluate(() => {
    window.__resizeLog = [];
  });

  // Playwright can't trigger Safari's address bar, but we can test with viewport resize
  await page.setViewportSize({ width: 390, height: 764 }); // 844 - 80
  await page.waitForTimeout(500);

  const layout2 = await getLayoutInfo(page);
  log('After viewport shrink:');
  log(JSON.stringify(layout2, null, 2));
  await page.screenshot({ path: path.join(OUT, '1b-portrait-shrunk.png') });

  const resizeLog1 = await getResizeLog(page);
  log(`\nResize events fired (${resizeLog1.length}):`);
  resizeLog1.forEach((e) => log(`  +${Math.round(e.ts)}ms  ${e.id}  ${e.w}x${e.h}`));

  // Restore
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const layout3 = await getLayoutInfo(page);
  log('\nAfter viewport restore:');
  log(JSON.stringify(layout3, null, 2));

  // Check if body height changed
  const heightChanged = layout1.bodyHeightPx !== layout2.bodyHeightPx;
  log(`\nBody height changed on viewport shrink: ${heightChanged} (${layout1.bodyHeightPx} → ${layout2.bodyHeightPx})`);
  if (layout2.gameHeightPx !== layout1.gameHeightPx) {
    log(`#game height changed: ${layout1.gameHeightPx} → ${layout2.gameHeightPx} ← THIS CAUSES CANVAS RESIZE`);
  } else {
    log(`#game height stable: ${layout1.gameHeightPx}`);
  }

  await ctx.close();
}

// ── Test 2: Portrait with VGP visible (simulates mid-game) ──────────────────
async function testWithVGP(browser) {
  log('\n=== TEST 2: Layout with VirtualGamepad visible ===');
  const ctx = await browser.newContext({
    ...devices['iPhone 14'],
    hasTouch: true,
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/play.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Simulate game started: show #game, init VGP
  await page.evaluate(() => {
    const game = document.getElementById('game');
    if (game) {
      game.style.display = '';
      game.classList.add('kn-playing');
    }
    if (window.VirtualGamepad) {
      VirtualGamepad.init();
      VirtualGamepad.setVisible(true);
    }
  });
  await page.waitForTimeout(500);

  const layout = await getLayoutInfo(page);
  log('Layout with VGP visible:');
  log(JSON.stringify(layout, null, 2));
  await page.screenshot({ path: path.join(OUT, '2a-vgp-visible.png') });

  // Now inject resize monitor and simulate viewport change
  await injectResizeMonitor(page);
  await page.evaluate(() => {
    window.__resizeLog = [];
  });
  await page.setViewportSize({ width: 390, height: 764 }); // address bar
  await page.waitForTimeout(600);

  const resizeLog = await getResizeLog(page);
  log(`\nResize events after viewport shrink (${resizeLog.length}):`);
  resizeLog.forEach((e) => log(`  +${Math.round(e.ts)}ms  ${e.id}  ${e.w}x${e.h}`));

  await page.screenshot({ path: path.join(OUT, '2b-vgp-viewport-shrunk.png') });

  await ctx.close();
}

// ── Test 3: Landscape - check layout stability ────────────────────────────────
async function testLandscapeLayout(browser) {
  log('\n=== TEST 3: Landscape layout ===');
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/play.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const game = document.getElementById('game');
    if (game) {
      game.style.display = '';
      game.classList.add('kn-playing');
    }
    if (window.VirtualGamepad) {
      VirtualGamepad.init();
      VirtualGamepad.setVisible(true);
    }
  });
  await page.waitForTimeout(500);

  const layout = await getLayoutInfo(page);
  log('Landscape layout with VGP:');
  log(JSON.stringify(layout, null, 2));
  await page.screenshot({ path: path.join(OUT, '3a-landscape-vgp.png') });

  // Simulate address bar (landscape reduces by ~50px typically)
  await injectResizeMonitor(page);
  await page.evaluate(() => {
    window.__resizeLog = [];
  });
  await page.setViewportSize({ width: 844, height: 340 });
  await page.waitForTimeout(500);

  const resizeLog = await getResizeLog(page);
  log(`\nLandscape resize events (${resizeLog.length}):`);
  resizeLog.forEach((e) => log(`  ${e.id}  ${e.w}x${e.h}`));

  const layout2 = await getLayoutInfo(page);
  log('\nAfter viewport shrink:');
  if (layout2.gameHeightPx !== layout.gameHeightPx) {
    log(`  #game height changed: ${layout.gameHeightPx} → ${layout2.gameHeightPx} ← CANVAS RESIZE SOURCE`);
  }
  if (layout2.vgpHeightPx !== layout.vgpHeightPx) {
    log(`  VGP height changed: ${layout.vgpHeightPx} → ${layout2.vgpHeightPx}`);
  }

  await page.screenshot({ path: path.join(OUT, '3b-landscape-shrunk.png') });
  await ctx.close();
}

// ── Test 4: Find all elements using svh/dvh in computed styles ────────────────
async function testSvhDvhAudit(browser) {
  log('\n=== TEST 4: CSS dvh/svh audit ===');
  const ctx = await browser.newContext({
    ...devices['iPhone 14'],
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/play.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Audit all inline styles and computed styles referencing viewport height
  const audit = await page.evaluate(() => {
    const results = [];
    // Check all stylesheets for dvh
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules ?? []) {
          const text = rule.cssText ?? '';
          if (text.includes('dvh')) {
            results.push({
              type: 'css-dvh',
              src: sheet.href?.split('/').slice(-1)[0] ?? 'inline',
              rule: text.slice(0, 200),
            });
          }
        }
      } catch (_) {}
    }
    // Check all elements with inline styles
    for (const el of document.querySelectorAll('[style]')) {
      const style = el.getAttribute('style');
      if (style.includes('dvh')) {
        results.push({ type: 'inline-dvh', id: el.id || el.tagName, style });
      }
      if (style.includes('vh')) {
        results.push({ type: 'inline-vh', id: el.id || el.tagName, style });
      }
    }
    return results;
  });

  if (audit.length === 0) {
    log('  No dvh found in stylesheets or inline styles ✓');
  } else {
    log(`  Found ${audit.length} dvh occurrences:`);
    audit.forEach((a) => log(`    [${a.type}] ${a.src ?? a.id}: ${(a.rule ?? a.style).slice(0, 120)}`));
  }

  // Check what's controlling body height
  const bodyInfo = await page.evaluate(() => {
    const body = document.body;
    const cs = window.getComputedStyle(body);
    return {
      height: cs.height,
      minHeight: cs.minHeight,
      maxHeight: cs.maxHeight,
      overflow: cs.overflow,
      display: cs.display,
      flexDirection: cs.flexDirection,
    };
  });
  log('\nBody computed styles:');
  log(JSON.stringify(bodyInfo, null, 2));

  await ctx.close();
}

// ── Test 5: EJS ResizeObserver investigation ─────────────────────────────────
async function testEJSResizeObserver(browser) {
  log('\n=== TEST 5: EJS ResizeObserver tracking ===');
  const ctx = await browser.newContext({
    ...devices['iPhone 14'],
    hasTouch: true,
  });
  const page = await ctx.newPage();

  // Inject before page load to catch all ResizeObserver construction
  await page.addInitScript(() => {
    window.__roInstances = [];
    window.__resizeLog = [];
    const Orig = window.ResizeObserver;
    window.ResizeObserver = class DiagRO extends Orig {
      constructor(cb) {
        const stack = new Error().stack;
        const id = window.__roInstances.length;
        window.__roInstances.push({ id, stack: stack?.split('\n').slice(2, 4).join(' | ') });
        const wrapped = (entries, obs) => {
          for (const e of entries) {
            window.__resizeLog.push({
              ts: Math.round(performance.now()),
              roId: id,
              el: e.target.id || e.target.className?.slice?.(0, 30) || e.target.tagName,
              w: Math.round(e.contentRect.width),
              h: Math.round(e.contentRect.height),
            });
          }
          return cb(entries, obs);
        };
        super(wrapped);
      }
    };
  });

  await page.goto(`${BASE}/play.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);

  const roInstances = await page.evaluate(() => window.__roInstances);
  log(`ResizeObserver instances created: ${roInstances.length}`);
  roInstances.forEach((r) => log(`  RO#${r.id}: ${r.stack}`));

  // Trigger viewport change
  await page.evaluate(() => {
    window.__resizeLog = [];
  });
  await page.setViewportSize({ width: 390, height: 764 });
  await page.waitForTimeout(500);

  const roLog = await page.evaluate(() => window.__resizeLog);
  log(`\nResize events on viewport shrink (${roLog.length}):`);
  roLog.forEach((e) => log(`  t=${e.ts}ms RO#${e.roId}  el="${e.el}"  ${e.w}x${e.h}`));

  await ctx.close();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });

try {
  await testPortraitLayout(browser);
  await testWithVGP(browser);
  await testLandscapeLayout(browser);
  await testSvhDvhAudit(browser);
  await testEJSResizeObserver(browser);
} finally {
  await browser.close();
}

log('\n=== DONE — screenshots in tests/diag-screenshots/ ===');
