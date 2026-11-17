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
  const button = host.locator('#contextual-reset button');
  const decoderEvidence = await host.evaluate(() => {
    const r = (a) => window.NetplayRollback.readRdram32(a);
    const hook = r(0x801144d0);
    const entry = (0x80000000 | ((hook & 0x03ffffff) << 2)) >>> 0;
    const branch = r(entry + 12);
    const target = entry + 16 + ((branch << 16) >> 16) * 4;
    return {
      hook,
      entry,
      words: Array.from({ length: 8 }, (_, i) => r(entry + i * 4)),
      target,
      targetWords: Array.from({ length: 8 }, (_, i) => r(target + i * 4)),
    };
  });
  await fs.writeFile(`${out}/decoder-runtime.json`, JSON.stringify(decoderEvidence, null, 2));
  await button.waitFor({ state: 'visible', timeout: 10000 });
  const pauseEvidence = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => ({
        rom: window.KNState.romHash,
        slot: window.KNState.slot,
        scene: window.NetplayRollback.readRdram32(0x800a4ad0),
        pointer: window.NetplayRollback.readRdram32(0x800a50e8),
        owner: window.NetplayRollback.readRdram32(0x801317e4),
        text: document.querySelector('#contextual-reset p')?.textContent,
      })),
    ),
  );
  await fs.writeFile(`${out}/native-pause.json`, JSON.stringify(pauseEvidence, null, 2));
  const box = await button.boundingBox();
  assert.ok(box && box.width >= 44 && box.height >= 44, 'reset hold target is accessible');
  await host.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await host.mouse.down();
  let approver = null;
  if (process.env.TWELVE_CB === '1') {
    await host.waitForTimeout(500);
    await host.mouse.up();
    approver = pages[1];
    await approver.bringToFront();
    const approveButton = approver.locator('#contextual-reset button');
    await approveButton.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await approver.locator('#contextual-reset p').textContent(), /approve/);
    assert.equal(await host.locator('#contextual-reset button').isVisible(), false);
    const phaseSnapshot = async () =>
      Promise.all(
        pages.map((page) =>
          page.evaluate(() => {
            const r = (a) => window.NetplayRollback.readRdram32(a);
            return {
              mode: r(0x804f7f58),
              requested: r(0x804fb348),
              owner: r(0x801317e4) >>> 24,
              scene: r(0x800a4ad0) >>> 24,
              status: (r(r(0x800a50e8) + 16) >>> 16) & 255,
            };
          }),
        ),
      );
    const requested = await phaseSnapshot();
    requested.forEach((p) => {
      assert.equal(p.mode, 1);
      assert.equal(p.requested, 1);
      assert.equal(p.owner, 1);
    });
    // Native Start on the receiving controller declines, without resetting.
    await approver.keyboard.down('v');
    await approver.waitForTimeout(150);
    await approver.keyboard.up('v');
    await approver.waitForTimeout(1000);
    const declined = await phaseSnapshot();
    declined.forEach((p) => {
      assert.equal(p.requested, 0);
      assert.equal(p.scene, 22);
      assert.equal(p.status, 1);
    });
    assert.equal(await approveButton.isVisible(), false);
    await host.bringToFront();
    await host.keyboard.down('v');
    await host.waitForTimeout(150);
    await host.keyboard.up('v');
    await button.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await host.locator('#contextual-reset p').textContent(), /request/);
    const hb = await button.boundingBox();
    await host.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await host.mouse.down();
    await host.waitForTimeout(500);
    await host.mouse.up();
    await approver.bringToFront();
    await approveButton.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await approver.locator('#contextual-reset p').textContent(), /approve/);
    await fs.writeFile(
      `${out}/12cb-phases.json`,
      JSON.stringify({ requested, declined, reRequested: await phaseSnapshot() }, null, 2),
    );
    await approver.screenshot({ path: `${out}/12cb-approval.png` });
    const ab = await approveButton.boundingBox();
    await approver.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await approver.mouse.down();
  }
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
    if (approver) await approver.mouse.up();
    await host.mouse.up();
    await host.bringToFront();
  }
  assert.equal(await button.isVisible(), false, 'contextual control hides on leaving pause');
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
