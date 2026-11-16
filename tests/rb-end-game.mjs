// Optional real-ROM lifecycle check after the normal battle/hash assertions.
// Lose only the one-shot end broadcast; production roster reconciliation and
// the host's acknowledged request must stop every running emulator.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export async function checkHostEnd(pages, out) {
  const before = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => ({
        matchId: window.KNState.matchId,
        gameOn: window.KNState.gameOn(),
        running: window._lockstepActive,
      })),
    ),
  );
  assert.ok(before.every((p) => p.gameOn && p.running && p.matchId === before[0].matchId));
  // Fault injection: no page receives game-ended. The server and the engines
  // otherwise run normally; no lifecycle state is written by this harness.
  await Promise.all(pages.map((page) => page.evaluate(() => window.__test_socket.off('game-ended'))));
  const started = Date.now();
  await pages[0].locator('#toolbar-more').click();
  await pages[0].locator('#toolbar-end').click();
  await Promise.all(
    pages.map(async (page) => {
      await page.waitForFunction(() => !window.KNState.gameOn() && !window._lockstepActive, null, { timeout: 5000 });
      await page.locator('#overlay').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('#toolbar').isVisible(), false);
    }),
  );
  const result = { passed: true, players: pages.length, elapsedMs: Date.now() - started, before };
  await fs.writeFile(`${out}/host-end.json`, JSON.stringify(result, null, 2));
  return result;
}
