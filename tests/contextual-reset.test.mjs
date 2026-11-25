// Run after npm run build. Real DOM/input integration without booting a ROM.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const html = (await readFile(new URL('web/play.html', root), 'utf8'))
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace(/<link\b[^>]*>/g, '');
const css = await readFile(new URL('web/static/play.css', root), 'utf8');
const bundle = await readFile(new URL('web/static/dist/kn-core.js', root), 'utf8');

// Synthetic read-only RAM exercises UI orchestration, not ROM compatibility.
test('contextual preview: stable gamepad, owner, delay, 12CB handoff and cancellation', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.KN_CHROMIUM ? { executablePath: process.env.KN_CHROMIUM } : {}),
  });
  try {
    for (const viewport of [
      { width: 393, height: 852 },
      { width: 430, height: 932 },
      { width: 852, height: 393 },
      { width: 932, height: 430 },
    ]) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      await page.setContent(html);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        Object.assign(window.KNState, {
          gameOn: () => true,
          slot: 0,
          matchId: 'preview-match',
          gameId: 'preview-room',
          romHash: 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d',
        });
        window.previewRam = new Map([
          [0x800a4ad0, 22 << 24],
          [0x800a50e8, 0x800a4d08],
          [0x800a4d18, 1 << 16],
          [0x801317e4, 0],
        ]);
        window.testHeld = new Set();
        window.testMap = window.KNShared.setupKeyTracking(null, window.testHeld);
        window.testPad = window.KNCore.page.startVirtualGamepad(window);
        window.testPad.init();
        window.testReset = window.KNCore.page.startContextualReset(
          window,
          window.KNState,
          (a) => window.previewRam.get(a) ?? null,
        );
        document.querySelector('#overlay')?.classList.add('hidden');
      });
      const boxes = () =>
        page.locator('.vgp-btn').evaluateAll((bs) => bs.map((b) => JSON.stringify(b.getBoundingClientRect())));
      const before = await boxes();
      const button = page.locator('#contextual-reset button');
      await page.evaluate(() => window.previewRam.set(0x800a4d18, 2 << 16));
      await page.waitForTimeout(500);
      assert.equal(await button.isVisible(), false);
      await button.waitFor({ state: 'visible' });
      assert.deepEqual(await boxes(), before);
      const rect = await button.boundingBox();
      assert.ok(rect && rect.height >= 48 && rect.x >= 0 && rect.x + rect.width <= viewport.width);
      if (process.env.OUT) {
        await mkdir(process.env.OUT, { recursive: true });
        await page.screenshot({ path: `${process.env.OUT}/contextual-${viewport.width}x${viewport.height}.png` });
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }],
      });
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), true);
      assert.equal(
        await button.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }))),
        false,
        'the native callout must not take over a long press',
      );
      await page.evaluate(() => window.previewRam.set(0x801317e4, 1 << 24));
      await button.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), false);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
      await page.evaluate(() => window.previewRam.set(0x801317e4, 0));
      await button.waitFor({ state: 'visible' });
      await button.focus();
      await page.keyboard.down('Space');
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), true);
      await page.keyboard.up('Space');
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), false);
      await page.evaluate(() => {
        window.KNState.romHash = 'S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403';
        for (const [a, v] of [
          [0x801144d0, 0x0c080000],
          [0x80200000, 0x3c0f8030],
          [0x80200004, 0x35ef0000],
          [0x80200008, 0x8def0000],
          [0x8020000c, 0x15e00004],
          [0x80200010, 0],
          [0x80200020, 0x3c088030],
          [0x80200024, 0x35080004],
          [0x80200028, 0x8d0f0000],
          [0x80300000, 1],
          [0x80300004, 0],
        ])
          window.previewRam.set(a, v);
      });
      await page.getByText(/12CB: request a reset/).waitFor({ state: 'visible' });
      await button.hover();
      await page.mouse.down();
      await page.evaluate(() => window.previewRam.set(0x80300004, 1));
      await button.waitFor({ state: 'hidden' });
      assert.equal(
        await page.evaluate(() => window.KNState.resetComboHeld),
        false,
        'same-owner CPU request must release',
      );
      await page.mouse.up();
      await button.waitFor({ state: 'visible' });
      assert.match(await page.locator('#contextual-reset p').textContent(), /approve/);
      await button.hover();
      await page.mouse.down();
      await page.evaluate(() => window.previewRam.set(0x800a4d18, 1 << 16));
      await button.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), false);
      await page.mouse.up();
      await context.close();
    }
  } finally {
    await browser.close();
  }
});

async function regressionPage(browser) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    Object.assign(window.KNState, {
      gameOn: () => true,
      slot: 0,
      matchId: 'regression',
      gameId: 'room',
      romHash: 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d',
    });
    window.testHeld = new Set();
    window.testMap = window.KNShared.setupKeyTracking(null, window.testHeld);
    window.readPause = (a) =>
      new Map([
        [0x800a4ad0, 22 << 24],
        [0x800a50e8, 0x800a4d08],
        [0x800a4d18, 2 << 16],
        [0x801317e4, 0],
      ]).get(a) ?? null;
    document.querySelector('#overlay')?.classList.add('hidden');
  });
  return page;
}

test('focused contextual button preserves Start while consuming Enter and Space', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.KN_CHROMIUM ? { executablePath: process.env.KN_CHROMIUM } : {}),
  });
  try {
    const page = await regressionPage(browser);
    await page.evaluate(() => {
      window.testReset = window.KNCore.page.startContextualReset(window, window.KNState, window.readPause);
    });
    const button = page.locator('#contextual-reset button');
    await button.waitFor({ state: 'visible' });
    await button.focus();
    for (const key of ['Enter', 'Space']) {
      await page.keyboard.down(key);
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), true);
      assert.equal(
        await page.evaluate(() => window.testHeld.has(13) || window.testHeld.has(32)),
        false,
        'activation must not reach controller',
      );
      await page.keyboard.up(key);
      assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), false);
    }
    await page.keyboard.down('v');
    assert.equal(
      await page.evaluate(() => window.testHeld.has(86)),
      true,
      'Start/V must reach gameplay while contextual reset has focus',
    );
    await page.keyboard.up('v');
    assert.equal(await page.evaluate(() => window.testHeld.has(86)), false);
  } finally {
    await browser.close();
  }
});

test('stopped contextual controller releases global listeners before replacement', async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.KN_CHROMIUM ? { executablePath: process.env.KN_CHROMIUM } : {}),
  });
  try {
    const page = await regressionPage(browser);
    const remaining = await page.evaluate(() => {
      const listeners = [];
      for (const target of [window, document]) {
        const add = target.addEventListener.bind(target),
          remove = target.removeEventListener.bind(target);
        target.addEventListener = (type, fn, ...rest) => {
          listeners.push({ target, type, fn });
          return add(type, fn, ...rest);
        };
        target.removeEventListener = (type, fn, ...rest) => {
          const i = listeners.findIndex((l) => l.target === target && l.type === type && l.fn === fn);
          if (i >= 0) listeners.splice(i, 1);
          return remove(type, fn, ...rest);
        };
      }
      window.oldReset = window.KNCore.page.startContextualReset(window, window.KNState, window.readPause);
      window.oldReset.stop();
      return listeners.map((l) => l.type);
    });
    assert.deepEqual(remaining, [], 'stop must unregister window/document callbacks');
    await page.evaluate(() => {
      window.testReset = window.KNCore.page.startContextualReset(window, window.KNState, window.readPause);
    });
    const button = page.locator('#contextual-reset button');
    await button.waitFor({ state: 'visible' });
    await button.focus();
    await page.keyboard.down('Space');
    assert.equal(await page.evaluate(() => window.KNState.resetComboHeld), true);
    await page.evaluate(() => {
      window.oldReset.close();
      window.oldReset.refresh();
      window.oldReset.stop();
    });
    assert.equal(
      await page.evaluate(() => window.KNState.resetComboHeld),
      true,
      'disposed controller must not overwrite replacement hold',
    );
    await page.keyboard.up('Space');
  } finally {
    await browser.close();
  }
});
