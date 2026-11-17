// Optional post-battle real-ROM check. Never writes ROM memory or substitutes
// reset input: the harness relinquishes its autopilot to production input.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export async function checkPausedReset(pages, out) {
  const host = pages[0];
  await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        window.__knResetOriginalModule = window.EJS_emulator.gameManager.Module;
        window.__knResetLiveInput = true;
        if (((window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255) !== 22)
          throw new Error('reset scenario requires an active SSB64 battle');
      }),
    ),
  );
  await host.setViewportSize({ width: 430, height: 932 });
  // Let already queued random input drain, then use the actual Start key.
  await host.waitForTimeout(1500);
  await host.evaluate(() => document.activeElement?.blur());
  await host.keyboard.down('v');
  await host.waitForTimeout(1000);
  await host.keyboard.up('v');
  await host.waitForTimeout(1000);
  await host.screenshot({ path: `${out}/reset-paused.png` });
  await host.locator('#toolbar-more').click();
  await host.locator('#toolbar-reset-combo').click();
  const button = host.locator('#reset-combo-hold');
  const box = await button.boundingBox();
  assert.ok(box && box.width >= 44 && box.height >= 44, 'reset hold target is accessible');
  await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await host.mouse.down();
  try {
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => ((window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255) === 24, null, {
          timeout: 30000,
        }),
      ),
    );
  } catch (error) {
    const diagnostics = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => {
          const ejs = window.EJS_emulator;
          return {
            scene: (window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255,
            frame: window.NetplayRollback.getHudCounters().currentFrame,
            held: window.KNState.resetComboHeld,
            slot: window.KNState.slot,
            gameOn: window.KNState.gameOn(),
            remap: window.KNState.remapActive,
            focused: document.hasFocus(),
            visibility: document.visibilityState,
            active: document.activeElement?.id,
            dialogOpen: document.querySelector('#reset-combo-dialog')?.open,
            settingsMenuOpen: ejs.settingsMenuOpen,
            popupOpen: ejs.isPopupOpen?.(),
            menuClass: ejs.elements?.menu?.className,
            inputs: window.__knResetInputSamples,
          };
        }),
      ),
    );
    await fs.writeFile(`${out}/reset-failure.json`, JSON.stringify(diagnostics, null, 2));
    await Promise.all(pages.map((page, index) => page.screenshot({ path: `${out}/reset-failure-${index}.png` })));
    throw new Error(`${error}; reset diagnostics: ${JSON.stringify(diagnostics)}`);
  } finally {
    await host.mouse.up();
  }
  await host.locator('#reset-combo-close').click();
  // SSB64's paused reset ends the round at NO CONTEST (scene 24), not
  // character select. A normal Start confirmation then returns to scene 16.
  // mnVSResultsCheckExit in the matching SSB64 decomp checks START_BUTTON,
  // not A: github.com/VetriTheRetri/ssb-decomp-re/blob/main/src/mn/mnvsmode/mnvsresults.c
  await host.screenshot({ path: `${out}/reset-results.png` });
  // Keep the production focus restored to More; gameplay must resume
  // without a manual blur or mouse click after closing the reset dialog.
  const resultsScenes = await Promise.all(
    pages.map((page) => page.evaluate(() => (window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255)),
  );
  assert.deepEqual(
    resultsScenes,
    pages.map(() => 24),
  );
  for (let attempt = 0; attempt < 15; attempt++) {
    const scenes = await Promise.all(
      pages.map((page) => page.evaluate(() => (window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255)),
    );
    if (scenes.every((scene) => scene === 16)) break;
    // Do not press again after the host has reached character select, even
    // while the guest catches up: that would select a fighter accidentally.
    if (scenes[0] === 24) {
      await host.keyboard.down('v');
      await host.waitForTimeout(150);
      await host.keyboard.up('v');
    }
    await host.waitForTimeout(1000);
  }
  try {
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(() => ((window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255) === 16, null, {
          timeout: 10000,
        }),
      ),
    );
  } catch (error) {
    const diagnostics = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => ({
          scene: (window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255,
          counters: window.NetplayRollback.getHudCounters(),
          inputs: window.__knResetInputSamples,
          focused: document.hasFocus(),
          held: window.KNState.resetComboHeld,
        })),
      ),
    );
    await fs.writeFile(`${out}/reset-confirm-failure.json`, JSON.stringify(diagnostics, null, 2));
    await Promise.all(
      pages.map((page, index) => page.screenshot({ path: `${out}/reset-confirm-failure-${index}.png` })),
    );
    throw new Error(`${error}; results confirmation diagnostics: ${JSON.stringify(diagnostics)}`);
  }

  const outcomes = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => ({
        scene: (window.NetplayRollback.readRdram32(0x800a4ad0) >>> 24) & 255,
        sameModule: window.EJS_emulator.gameManager.Module === window.__knResetOriginalModule,
        gameOn: window.KNState.gameOn(),
        connected: Object.values(window.KNState.peers).filter((p) => p.dc?.readyState === 'open').length,
        held: window.KNState.resetComboHeld,
      })),
    ),
  );
  outcomes.forEach((result) => {
    assert.equal(result.scene, 16);
    assert.equal(result.sameModule, true, 'no emulator restart');
    assert.equal(result.gameOn, true, 'room still playing');
    assert.ok(result.connected >= pages.length - 1, 'all peers remain connected');
    assert.equal(result.held, false, 'reset input released');
  });
  await host.screenshot({ path: `${out}/reset-character-select.png` });
  return { passed: true, resultsScenes, peers: outcomes };
}
