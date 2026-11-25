import assert from 'node:assert/strict';
import { trackHashLag } from './hash-lag.mjs';

// The native read/apply probe calls this at the same simulation frame on both sides of a reload.
export function installFightProbe() {
  window.__knReadFight = () => {
    const rom = window.KNCore?.addressMapFor(window.KNState?.romHash);
    const rb = window.NetplayRollback;
    if (!rom || !rb?.readRdram32) return null;
    const [stocks, stride, scene, header, , rng] = rom.values;
    const byte = (addr) => {
      const word = rb.readRdram32(addr & ~3);
      return word === null ? null : (word >>> (8 * (3 - (addr & 3)))) & 255;
    };
    return {
      rom: rom.name,
      scene: byte(scene),
      battle: rom.scenes.battle,
      status: byte(header + rom.battleStatus.offset),
      ongoing: rom.battleStatus.ongoing,
      stage: byte(header + 1),
      elapsed: rb.readRdram32(header + 24),
      rng: rb.readRdram32(rng),
      fighters: [0, 1].map((slot) => byte(header + 0x20 + stride * slot + 3)),
      stocks: [0, 1].map((slot) => byte(stocks + stride * slot)),
    };
  };
}

async function savedMatch(room) {
  if (!(await indexedDB.databases()).some((db) => db.name === 'kn-match-return')) return null;
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('kn-match-return');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const record = await new Promise((resolve, reject) => {
      const get = db.transaction('matches').objectStore('matches').get(room);
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    return (
      record && {
        frame: record.frame,
        delay: record.delay,
        source: record.scope.matchId,
        roster: record.scope.roster,
        mode: record.scope.mode,
        rom: record.scope.romHash,
        seal: record.seal,
      }
    );
  } finally {
    db.close();
  }
}

function identity() {
  return {
    pid: sessionStorage.getItem('kn-player-id'),
    slot: window.KNState?.slot,
    rom: window.KNState?.romHash,
    matchId: window.KNState?.matchId,
  };
}

function observeRestore() {
  const rows = (window.__knRestoreLog = []);
  const listen = () => {
    const socket = window.__test_socket;
    if (!socket) return false;
    const capture = (event, data) => {
      if (!['match-return-ready', 'match-return-go', 'game-ended'].includes(event)) return;
      const sync = window.NetplayRollback?.exportSyncLog?.()?.split('\n') ?? [];
      rows.push({
        event,
        data,
        delay: sync.findLast((line) => line.includes('delay negotiated:')),
        sync: sync.slice(-20),
      });
    };
    socket.onAnyOutgoing(capture);
    socket.prependAny(capture);
    return true;
  };
  if (!listen()) {
    const timer = setInterval(() => {
      if (listen()) clearInterval(timer);
    }, 20);
  }
}

function sampleHashes() {
  const hashes = (window.__knReturnHashes = {});
  const m = window.EJS_emulator.gameManager.Module;
  const tick = m._kn_post_tick;
  let lastFrame = -1;
  m._kn_post_tick = function (...args) {
    const current = tick.apply(this, args);
    if ((m._kn_get_replay_depth?.() ?? 0) !== 0) return current;
    const lag = window.__knHashLag.lag;
    if (lag !== null) {
      const frame = current - lag;
      if (current < lastFrame) for (const key of Object.keys(hashes)) if (+key >= frame) delete hashes[key];
      const gameplay = m._kn_gameplay_hash(frame) >>> 0;
      const gameState = m._kn_game_state_hash(frame) >>> 0;
      if (gameplay && gameState) hashes[frame] = [gameplay, gameState];
    }
    lastFrame = current;
    return current;
  };
}

const until = (page, fn, arg, timeout = 60000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });

export async function checkFightReturn({ host, guest, baseUrl, room, out, mode, jitter }) {
  const report = { passed: false };
  let returned;
  try {
    assert.ok(['rollback', 'lockstep'].includes(mode), 'fight return expects rollback or lockstep');
    assert.equal(jitter, 20, 'the fight return acceptance scenario requires JITTER=20');
    const pingDelay = Number(process.env.FIGHT_RETURN_PING_DELAY_MS ?? 0);
    assert.ok(Number.isFinite(pingDelay) && pingDelay >= 0, 'FIGHT_RETURN_PING_DELAY_MS must be nonnegative');
    const original = await Promise.all([host, guest].map((page) => page.evaluate(identity)));
    report.original = original;
    const source = original[0].matchId;
    assert.ok(source && original[0].rom && original[0].pid && original[1].pid);
    assert.notEqual(original[0].pid, original[1].pid);
    assert.deepEqual(
      original.map((player) => player.slot),
      [0, 1],
    );
    assert.equal(original[1].matchId, source);
    assert.equal(original[1].rom, original[0].rom);
    await Promise.all(
      [host, guest].map((page) =>
        page.evaluate(() => {
          window.__knResetLiveInput = true;
        }),
      ),
    );
    await guest.evaluate(observeRestore);
    await guest.evaluate(() => {
      window.__knResyncExtras.applies.length = 0;
      window.__knReturnEvents = { starts: [], releases: [], ends: [] };
      const socket = window.__test_socket;
      socket.on('game-started', ({ matchId, resumeFromMatchId }) =>
        window.__knReturnEvents.starts.push({ matchId, resumeFromMatchId }),
      );
      socket.on('match-return-go', ({ matchId }) => window.__knReturnEvents.releases.push(matchId));
      socket.on('game-ended', ({ reason, matchId }) => window.__knReturnEvents.ends.push({ reason, matchId }));
    });
    const reads = new Map();
    await host.exposeFunction('__knSavedFight', (frame, fight) => {
      reads.set(frame, fight);
    });
    const capture = await host.evaluate(() => ({
      reads: window.__knResyncExtras.reads.map(({ frame, fight }) => [frame, fight]),
      battleAt: window.__tp.inBattleAt,
    }));
    for (const [frame, fight] of capture.reads) if (fight) reads.set(frame, fight);
    assert.ok(capture.battleAt >= 0);
    report.step = 'waiting for original host checkpoint in battle';
    // The game writes its own IndexedDB save. Never inject a save or request a capture.
    const deadline = Date.now() + 45000;
    for (;;) {
      const latest = await host.evaluate(savedMatch, room);
      const fight = latest && reads.get(latest.frame);
      if (
        latest?.source === source &&
        latest.frame >= capture.battleAt + 240 &&
        fight &&
        fight.scene === fight.battle &&
        fight.status === fight.ongoing
      )
        break;
      if (Date.now() >= deadline) {
        report.latest = latest && { frame: latest.frame, source: latest.source, fight };
        report.captureCount = reads.size;
        throw new Error('the host never stored a checkpoint from this fight');
      }
      await host.waitForTimeout(350);
    }
    const ctx = host.context();
    const closingAt = Date.now();
    report.step = 'waiting for the guest to hold the fight after host tab closure';
    await host.close();
    const banner = guest.locator('#host-wait-banner');
    await banner.waitFor({ state: 'visible', timeout: 10000 });
    const waiting = banner.getByRole('status').filter({ hasText: 'Waiting for them to return' });
    await waiting.waitFor({ state: 'visible', timeout: 20000 });
    const heldAfterMs = Date.now() - closingAt;
    const transport = await guest.evaluate(() => {
      const host = Object.values(window.KNState.peers || {}).find((peer) => peer.slot === 0);
      return {
        live: window.NetplayRollback.hostGameConnected(),
        pc: host?.pc?.connectionState,
        dc: host?.dc?.readyState,
      };
    });
    assert.equal(transport.live, false);
    const timer = (await banner.getByRole('timer').innerText()).match(/^(\d+):(\d{2})$/);
    assert.ok(timer, 'the guest must see a return clock');
    const seconds = Number(timer[1]) * 60 + Number(timer[2]);
    assert.ok(seconds > 0 && seconds <= 120);
    const guestFrame = () => guest.evaluate(() => window.EJS_emulator.gameManager.Module._kn_get_frame());
    const before = await guestFrame();
    await guest.waitForTimeout(1300);
    report.guestWait = {
      seconds,
      heldAfterMs,
      transport,
      before,
      after: await guestFrame(),
      message: await waiting.innerText(),
    };
    assert.equal(report.guestWait.after, before, 'the guest kept simulating after losing the host');
    assert.equal(await guest.locator('#toolbar-status').isVisible(), false);
    await guest.screenshot({ path: out + '/fight-return-countdown.png' });
    returned = await ctx.newPage();
    // A new transport measures a different RTT from the connection that wrote the save.
    if (pingDelay)
      await returned.addInitScript((ms) => {
        window.__knReturnPingDelay = ms;
      }, pingDelay);
    await returned.goto(baseUrl + '/');
    const saved = await returned.evaluate(savedMatch, room);
    assert.equal(saved?.source, source, 'the fresh tab must find the original match in IndexedDB');
    assert.deepEqual(
      saved.roster,
      original.map((player) => player.pid),
    );
    assert.equal(saved.rom, original[0].rom);
    assert.equal(saved.mode, mode);
    assert.ok(saved.seal);
    const fight = reads.get(saved.frame);
    report.saved = { ...saved, fight };
    assert.ok(fight, 'the stored frame had no original native capture');
    assert.equal(fight.scene, fight.battle);
    assert.equal(fight.status, fight.ongoing);
    assert.ok(fight.rng > 0);
    const noFighter = fight.rom === 'ssb64-us' ? 12 : 0xff;
    assert.ok(fight.fighters.every((fighter) => Number.isInteger(fighter) && fighter < noFighter));
    assert.ok(fight.stocks.every((stock) => Number.isInteger(stock) && stock < 99));

    report.step = 'waiting for the return link, then for both restored peers';
    await returned.getByRole('link', { name: 'Return to room', exact: true }).click({ timeout: 15000 });
    const pages = [returned, guest];
    await returned.evaluate(observeRestore);
    // A new document can need a real user gesture to unlock audio. The guest stays in its
    // previously activated document and must be able to finish without a second tap.
    await until(
      returned,
      () =>
        document.querySelector('#gesture-prompt:not(.hidden)') ||
        window.__knRestoreLog.some((row) => row.event === 'match-return-ready' || row.event === 'game-ended'),
    );
    const gate = returned.locator('#gesture-prompt:not(.hidden)');
    report.hostAudioTap = await gate.isVisible();
    if (report.hostAudioTap) await gate.click();
    await until(
      guest,
      (old) =>
        window.__knReturnEvents.releases.length ||
        window.__knReturnEvents.ends.some((end) => end.matchId !== old || end.reason !== 'host-rewind'),
      source,
    );
    report.events = await guest.evaluate(() => window.__knReturnEvents);
    const resumed = report.events.starts.find((start) => start.resumeFromMatchId === source);
    assert.ok(resumed?.matchId && resumed.matchId !== source, 'the new transport must point to the original fight');
    assert.ok(
      report.events.releases.includes(resumed.matchId),
      'the original roster did not release the restored fight',
    );
    await banner.waitFor({ state: 'hidden', timeout: 10000 });
    if (pingDelay) {
      const delay = await returned.evaluate(
        () => window.__knRestoreLog.find((row) => row.event === 'match-return-ready')?.delay,
      );
      const measured = /own=(\d+) effective=(\d+)/.exec(delay ?? '');
      assert.ok(measured, 'the returning host did not report its startup delay');
      report.delay = { saved: saved.delay, measured: Number(measured[1]), effective: Number(measured[2]) };
      assert.notEqual(report.delay.measured, saved.delay, 'the return must exercise a changed RTT delay');
      assert.equal(report.delay.effective, saved.delay, 'the returned host must keep its saved input window');
    }
    report.restored = await Promise.all(
      pages.map(async (page, slot) => {
        await until(
          page,
          (id) => window.KNState?.matchId === id && window.EJS_emulator?.gameManager?.Module?._kn_post_tick,
          resumed.matchId,
        );
        assert.equal(await page.evaluate(() => window.NetplayRollback.getInfo().frameDelay), saved.delay);
        const player = await page.evaluate(identity);
        assert.deepEqual(player, { ...original[slot], matchId: resumed.matchId });
        const applied = await page.evaluate(
          (frame) => window.__knResyncExtras.applies.filter((record) => record.frame === frame).at(-1)?.fight,
          saved.frame,
        );
        assert.deepEqual(applied, fight, 'native restore changed the saved battle state at P' + (slot + 1));
        return { slot, fight: applied };
      }),
    );

    report.step = 'comparing finalized rollback frames';
    await Promise.all(
      pages.map(async (page) => {
        await page.evaluate(trackHashLag);
        await page.evaluate(sampleHashes);
      }),
    );
    await Promise.all([returned.keyboard.down('d'), guest.keyboard.down('a')]);
    await guest.waitForTimeout(450);
    await Promise.all([returned.keyboard.up('d'), guest.keyboard.up('a')]);
    await Promise.all(pages.map((page) => until(page, () => Object.keys(window.__knReturnHashes).length >= 360)));
    const [left, right] = await Promise.all(pages.map((page) => page.evaluate(() => window.__knReturnHashes)));
    const common = Object.keys(left)
      .map(Number)
      .filter((f) => f > saved.frame && right[f])
      .sort((a, b) => a - b);
    let longest = 0,
      run = 0,
      previous = -1;
    for (const frame of common) {
      assert.deepEqual(left[frame], right[frame], 'finalized gameplay/game-state mismatch at frame ' + frame);
      run = frame === previous + 1 ? run + 1 : 1;
      longest = Math.max(longest, run);
      previous = frame;
    }
    report.hashes = { compared: common.length, first: common[0], last: common.at(-1), consecutive: longest };
    assert.ok(longest >= 300, 'fewer than 300 consecutive confirmed frames matched');
    const fights = await Promise.all(pages.map((page) => page.evaluate(() => window.__knReadFight())));
    for (const live of fights) {
      assert.equal(live.scene, fight.battle);
      assert.deepEqual(live.fighters, fight.fighters);
      assert.ok(live.elapsed >= fight.elapsed, 'the restored fight clock went backwards');
    }
    report.passed = true;
    delete report.step;
  } catch (error) {
    report.error = String(error);
    report.events = await guest.evaluate(() => window.__knReturnEvents).catch(() => null);
    for (const [role, page] of [
      ['host', returned || host],
      ['guest', guest],
    ]) {
      if (page.isClosed()) continue;
      await page.screenshot({ path: out + '/fight-return-' + role + '.png', timeout: 5000 }).catch(() => {});
      report[role + 'Status'] = await page
        .evaluate(() => ({
          status: document.querySelector('#engine-status')?.textContent,
          notice: document.querySelector('#host-reload-notice')?.textContent,
          recovery: window.__knRestoreLog,
          sync: window.NetplayRollback?.exportSyncLog?.()?.split('\n').slice(-15),
        }))
        .catch(() => null);
    }
  }
  return report;
}
