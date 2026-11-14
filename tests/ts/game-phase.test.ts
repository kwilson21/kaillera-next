import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROM_ADDRESSES, scenesFor } from '../../web/src/address-maps.ts';
import { fieldEligibleInPhase } from '../../web/src/desync-fields.ts';
import { isSteeredMenu, matchState } from '../../web/src/game-phase.ts';

const SSB64 = scenesFor(null, 'ssb64');
assert.ok(SSB64);

// ── the lines these rules replaced, kept as an oracle ───────────────────────
// web/static/netplay-rollback.js before the scene numbers moved to the
// per-game table: literal Super Smash Bros. scene numbers.
const oldInBattleTransition = (scene: number, status: number) => scene === 22 && status === 0;
const oldGameplay = (scene: number, status: number) => scene === 22 && status === 1;
const oldPaused = (scene: number, status: number) => scene === 22 && status === 2;
const oldMenu = (scene: number) => scene === 1 || (scene >= 7 && scene <= 21);

test('for Super Smash Bros. every scene and status reads as the literals read it', () => {
  let compared = 0;
  for (let scene = -1; scene <= 60; scene++) {
    assert.equal(isSteeredMenu(scene, SSB64.title, SSB64.menuFirst, SSB64.menuLast), oldMenu(scene), `scene ${scene}`);
    for (let status = -1; status <= 6; status++) {
      const state = matchState(scene, status, SSB64.battle);
      assert.equal(state === 'starting', oldInBattleTransition(scene, status));
      assert.equal(state === 'playing', oldGameplay(scene, status));
      assert.equal(state === 'paused', oldPaused(scene, status));
      assert.equal(state === 'elsewhere', scene !== 22);
      compared++;
    }
  }
  assert.equal(compared, 496);
});

test("another game's numbers are its own", () => {
  // A made-up game: match is scene 4, title 0, menus 1 to 3.
  assert.equal(matchState(4, 1, 4), 'playing');
  assert.equal(matchState(22, 1, 4), 'elsewhere');
  assert.equal(isSteeredMenu(0, 0, 1, 3), true);
  assert.equal(isSteeredMenu(2, 0, 1, 3), true);
  assert.equal(isSteeredMenu(4, 0, 1, 3), false);
  assert.equal(isSteeredMenu(16, 0, 1, 3), false);
  // The desync detector's battle-only and character-select fields follow.
  assert.equal(fieldEligibleInPhase(0, 4, 4, 2), true);
  assert.equal(fieldEligibleInPhase(0, 22, 4, 2), false);
  assert.equal(fieldEligibleInPhase(8, 2, 4, 2), true);
  assert.equal(fieldEligibleInPhase(8, 16, 4, 2), false);
});

test('a game nobody has described has no match scene and no steered menu', () => {
  assert.equal(scenesFor(null, 'mario-kart-64'), null);
  assert.equal(scenesFor('Snot-a-known-rom', null), null);
  for (let scene = 0; scene <= 60; scene++) {
    assert.equal(isSteeredMenu(scene, -1, -1, -1), false);
    for (let status = 0; status <= 3; status++) assert.equal(matchState(scene, status, -1), 'elsewhere');
  }
});

test('a ROM is looked up by its hash first, then by its game', () => {
  for (const [hash, rom] of Object.entries(ROM_ADDRESSES)) assert.equal(scenesFor(hash, null), rom.scenes);
  // A Smash Remix build that is not in the table still has the game's scenes.
  assert.deepEqual(scenesFor('Sunlisted-remix-build', 'smash-remix'), SSB64);
  assert.deepEqual(scenesFor(undefined, 'ssb64'), SSB64);
});

test('every described game has a sound scene table', () => {
  for (const rom of Object.values(ROM_ADDRESSES)) {
    const s = rom.scenes;
    for (const value of Object.values(s)) assert.ok(Number.isInteger(value) && value >= 0 && value <= 255);
    assert.ok(s.menuFirst <= s.menuLast);
    // A match is not a menu.
    assert.equal(isSteeredMenu(s.battle, s.title, s.menuFirst, s.menuLast), false);
  }
});

// ── no scene number is compared with a literal outside the table ────────────

test('the engine and the detector compare no scene with a literal number', () => {
  const sceneLiteral = /\b(?:scene|sceneCurr|safeScene|phase)\w*\s*(?:===|!==|>=|<=|>|<)\s*\d+/i;
  // Lines that are about something else, or are one game's own routine by name.
  const allowed = [
    /INITIAL_SMASH_/, // Smash Remix's boot sequence, gated on _isSmashRemix
    /^for \(let scene = 0; scene < 256;/, // a loop over every possible scene byte
  ];
  for (const file of ['netplay-rollback.js', 'kn-desync-detector.js']) {
    const offenders = readFileSync(new URL(`../../web/static/${file}`, import.meta.url), 'utf8')
      .split('\n')
      .map((line, index) => ({ line: line.trim(), at: `${file}:${index + 1}` }))
      .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
      .filter(({ line }) => sceneLiteral.test(line) && !allowed.some((ok) => ok.test(line)));
    assert.deepEqual(offenders, [], `scene compared with a literal in ${file}`);
  }
});
