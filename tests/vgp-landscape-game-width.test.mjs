// Regression test for the iPad landscape "stuck at 0 width" bug: the
// landscape rule in virtual-gamepad.js must give #game a definite width.
// With width:auto it shrink-to-fits a 0-width canvas buffer after hibernate,
// and the game never reappeared on iPad restarts.
//
//   node --test tests/vgp-landscape-game-width.test.mjs   (needs: npx playwright install webkit)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { webkit } from 'playwright';

const dir = path.dirname(fileURLToPath(import.meta.url));
const playCss = path.join(dir, '../web/static/play.css');
const emulatorCss = path.join(dir, '../web/static/ejs/emulator.min.css');
const vgpScript = path.join(dir, '../web/static/virtual-gamepad.js');

test('#game keeps a definite width in landscape (does not collapse when the canvas buffer is 0)', async () => {
  const browser = await webkit.launch();
  try {
    // iPad Pro 11" in landscape, touch enabled — the reported device/config.
    const context = await browser.newContext({
      viewport: { width: 1194, height: 760 },
      deviceScaleFactor: 2,
      hasTouch: true,
    });
    const page = await context.newPage();
    await page.setContent(
      '<div id="game" class="ejs_parent"><div class="ejs_canvas_parent"><canvas class="ejs_canvas" width="0" height="0"></canvas></div></div>',
    );
    await page.addStyleTag({ path: playCss });
    await page.addStyleTag({ path: emulatorCss });
    await page.addScriptTag({ path: vgpScript });

    await page.evaluate(() => window.VirtualGamepad.init());

    const { gameWidth, canvasWidth } = await page.evaluate(() => ({
      gameWidth: document.getElementById('game').getBoundingClientRect().width,
      canvasWidth: document.querySelector('.ejs_canvas').getBoundingClientRect().width,
    }));

    // A 0-width drawing buffer must not collapse #game: the canvas box (what
    // RetroArch's ResizeObserver reads) should sit at the landscape max-width
    // (~746px at this viewport), not shrink to the canvas's own (0) size.
    assert.ok(canvasWidth > 600, `expected canvas box width > 600, got ${canvasWidth} (game width ${gameWidth})`);
  } finally {
    await browser.close();
  }
});
