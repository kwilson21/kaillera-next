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

test('reset shortcut: iPhone layout, ownership, hold, keyboard and cancellation', async () => {
  const launchOptions = { headless: true };
  if (process.env.KN_CHROMIUM) launchOptions.executablePath = process.env.KN_CHROMIUM;
  const browser = await chromium.launch(launchOptions);
  try {
    for (const viewport of [
      { width: 430, height: 932 },
      { width: 932, height: 430 },
      { width: 393, height: 852 },
    ]) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      await page.setContent(html);
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(() => {
        // Real page controls and input collector; only emulator boot is omitted.
        window.KNState.gameOn = () => true;
        window.KNState.slot = 0;
        window.testHeld = new Set();
        window.testMap = window.KNShared.setupKeyTracking(null, window.testHeld);
        window.testPad = window.KNCore.page.startVirtualGamepad(window);
        window.testPad.init();
        window.testReset = window.KNCore.page.startResetCombo(window, window.KNState);
        document.querySelector('#overlay')?.classList.add('hidden');
        document.querySelector('#toolbar').classList.remove('hidden');
        document.querySelector('#toolbar-reset-combo').addEventListener('click', () => {
          window.KNCore.play.menus.closeMoreMenu();
          window.testReset.open();
        });
        document.querySelector('#toolbar-more').addEventListener('click', window.KNCore.play.menus.toggleMoreMenu);
      });
      const boxes = () =>
        page.locator('.vgp-btn').evaluateAll((buttons) =>
          buttons.map((b) => {
            const { x, y, width, height } = b.getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
      const before = await boxes();
      await page.locator('#toolbar-more').click();
      await page.locator('#toolbar-reset-combo').click();
      assert.deepEqual(await boxes(), before, 'opening reset must not move existing controls');
      const button = page.locator('#reset-combo-hold');
      const rect = await button.boundingBox();
      assert.ok(rect && rect.height >= 44 && rect.x >= 0 && rect.x + rect.width <= viewport.width);
      const input = () =>
        page.evaluate(() => window.KNShared.readLocalInput(0, window.testMap, window.testHeld).buttons);
      if (process.env.OUT) {
        await mkdir(process.env.OUT, { recursive: true });
        await page.screenshot({ path: `${process.env.OUT}/reset-${viewport.width}x${viewport.height}.png` });
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }],
      });
      assert.equal(await input(), 6147, 'one touch sends all four buttons');
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      assert.equal(await input(), 0, 'touch release clears only the shortcut');
      await cdp.detach();
      await page.evaluate(() => {
        window.KNState.touchInput[0] = 1;
      });
      await button.hover();
      await page.mouse.down();
      assert.equal(await input(), 6147);
      // The chord remains held for repeated engine samples; no fixed-duration assumption.
      assert.deepEqual(
        await page.evaluate(() =>
          Array.from({ length: 120 }, () => window.KNShared.readLocalInput(0, window.testMap, window.testHeld).buttons),
        ),
        Array(120).fill(6147),
      );
      await page.mouse.up();
      assert.equal(await input(), 1, 'release preserves independently held A');
      await button.focus();
      await page.keyboard.down('Space');
      assert.equal(await input(), 6147);
      await page.keyboard.up('Space');
      assert.equal(await input(), 1, 'keyboard release does not synthesize a sticky click');
      await page.keyboard.down('Enter');
      assert.equal(await input(), 6147);
      await page.keyboard.up('Enter');
      assert.equal(await input(), 1);
      await button.hover();
      await page.mouse.down();
      assert.equal(await input(), 6147);
      await button.dispatchEvent('pointercancel');
      assert.equal(await input(), 1);
      await page.mouse.up();
      // Screen-reader click-only activation is announced and can be toggled off.
      await button.evaluate((el) => el.click());
      assert.equal(await input(), 6147);
      await button.evaluate((el) => el.click());
      assert.equal(await input(), 1);
      await button.evaluate((el) => el.click());
      await page.keyboard.press('Escape');
      assert.equal(await input(), 1);
      await page.evaluate(() => window.testReset.open());
      await button.evaluate((el) => el.click());
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.equal(await input(), 1);
      await page.evaluate(() => window.testReset.open());
      await button.evaluate((el) => el.click());
      await page.evaluate(() => {
        window.KNState.gameOn = () => false;
        window.testReset.close();
      });
      assert.equal(await input(), 1);
      await page.evaluate(() => {
        window.KNState.gameOn = () => true;
        window.KNState.slot = null;
        window.testReset.open();
      });
      assert.equal(await page.locator('#reset-combo-dialog').evaluate((el) => el.open), false);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
