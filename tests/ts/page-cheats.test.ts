/**
 * The standard cheats are set, and cleared, only once the core has opened
 * the ROM (web/src/page/shared.ts, coreHasOpenedRom).
 *
 * EmulatorJS makes its game manager, Module and all, before it downloads the
 * ROM and calls main, and the core sets up its cheat list when it opens the
 * ROM. A cheat set before then walked a list that did not exist yet and
 * trapped ("cheat application failed: memory access out of bounds", once per
 * boot, on whichever page applied its cheats first). The fake core below traps
 * the same way while no frame has run.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { coreHasOpenedRom, createShared, SSB64_ONLINE_CHEATS } from '../../web/src/page/shared.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeCore {
  frames: number;
  set: [number, number, string][];
  resets: number;
  errors: string[];
}

/** A page with an emulator whose core has run `frames` frames, and its console errors. */
const fakePage = (): FakeCore => {
  const core: FakeCore = { frames: 0, set: [], resets: 0, errors: [] };
  const trapUntilOpen = (): void => {
    if (core.frames < 1) throw new Error('memory access out of bounds');
  };
  const gameManager = {
    Module: { _get_current_frame_count: (): number => core.frames },
    setCheat: (index: number, enabled: number, code: string): void => {
      trapUntilOpen();
      core.set.push([index, enabled, code]);
    },
    resetCheat: (): void => {
      trapUntilOpen();
      core.resets++;
    },
    setKeyboardEnabled: (): void => {},
  };
  const window = { EJS_emulator: { gameManager }, KNState: { matchId: null } };
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { querySelector: () => null }, configurable: true });
  const realError = console.error;
  console.error = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    // Only the page's own lines: Node reports some warnings here too.
    if (line.startsWith('[netplay]')) core.errors.push(line);
  };
  restore.push(() => {
    console.error = realError;
  });
  return core;
};

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'document');
});

test('the ROM is open once a frame has run, or when the core has no frame count', () => {
  assert.equal(coreHasOpenedRom({ _get_current_frame_count: () => 0 }), false);
  assert.equal(coreHasOpenedRom({ _get_current_frame_count: () => 1 }), true);
  assert.equal(coreHasOpenedRom({ _get_current_frame_count: () => 240 }), true);
  assert.equal(coreHasOpenedRom({}), true);
});

test('the standard cheats wait for the core to open the ROM', async () => {
  const core = fakePage();
  const applied = createShared().applyStandardCheats(SSB64_ONLINE_CHEATS);
  // The emulator is up but has not run a frame: nothing is set, nothing traps.
  await sleep(350);
  assert.deepEqual(core.set, []);
  core.frames = 1;
  await applied;
  assert.deepEqual(
    core.set,
    SSB64_ONLINE_CHEATS.map((cheat, i) => [i, 1, cheat.code]),
  );
  assert.deepEqual(core.errors, []);
});

test('clearing the cheats waits for the core to open the ROM too', async () => {
  const core = fakePage();
  const cleared = createShared().clearCheats();
  await sleep(350);
  assert.equal(core.resets, 0);
  core.frames = 3;
  await cleared;
  assert.equal(core.resets, 1);
  assert.deepEqual(
    core.set,
    SSB64_ONLINE_CHEATS.map((cheat, i) => [i, 0, cheat.code]),
  );
  assert.deepEqual(core.errors, []);
});

test('a core already running sets the cheats at once', async () => {
  const core = fakePage();
  core.frames = 120;
  await createShared().applyStandardCheats(SSB64_ONLINE_CHEATS);
  assert.equal(core.set.length, SSB64_ONLINE_CHEATS.length);
  assert.deepEqual(core.errors, []);
});
