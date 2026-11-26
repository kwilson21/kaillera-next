import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { createSyncLogRing } from '../../web/src/sync-log-ring.ts';
import { createBoundary } from '../../web/src/socket-boundary.ts';
import { sessionLogKeepaliveBody } from '../../web/src/session-log-keepalive.ts';

const engine = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const source = engine.slice(engine.indexOf('  const _buildFlushPayload'), engine.indexOf('  // -- Canvas pixel hash'));
interface Body {
  matchId: string;
  epoch: string;
  entries: { seq: number }[];
  audit: { epoch: string; entries: { seq: number }[] };
  summary: { frames: number; omittedOnExit?: { logEntries: number; auditEntries: number } };
}

function page(cap: number) {
  const ring = createSyncLogRing(50);
  const posts: { url: string; body: Body; keepalive: boolean; bytes: number }[] = [];
  type Reply = (ack: { lastSeq: number; auditLastSeq: number } | undefined) => void;
  const replies: Reply[] = [];
  const audit: { seq: number }[] = [];
  const deadlines: (() => void)[] = [];
  let busy = false;
  const ctx = vm.createContext({
    window: { _playerSlot: 0, KNCore: { sessionLogKeepaliveBody } },
    navigator: { userAgent: 'test' },
    performance,
    TextEncoder,
    encodeURIComponent,
    _syncLogRing: ring,
    _syncLogAckedSeq: -1,
    _auditEpoch: 'audit-A',
    _auditAckedSeq: -1,
    _auditPending: audit,
    SYNC_LOG_FLUSH_MAX_ENTRIES: cap,
    AUDIT_FLUSH_MAX: cap,
    _cachedMatchId: 'match-A',
    _cachedRoom: 'room A',
    _cachedUploadToken: 'token A',
    KNState: {},
    _socketFlushFails: 0,
    _modeName: () => 'rollback',
    _frameNum: 44,
    _startTime: 0,
    _buildRollbackStats: () => null,
    _useCRollback: false,
    _peerBoundary: () => createBoundary(() => {}),
    socket: {
      connected: true,
      emit: (_event: string, _data: Body, reply: Reply) => replies.push(reply),
    },
    setTimeout: (callback: () => void, ms: number) => {
      if (ms === 5000) deadlines.push(callback);
      else queueMicrotask(callback);
    },
    fetch: async (url: string, options: { body: string; keepalive: boolean }) => {
      const body: Body = JSON.parse(options.body);
      posts.push({ url, body, keepalive: options.keepalive, bytes: Buffer.byteLength(options.body) });
      if (busy) {
        busy = false;
        return { ok: false, status: 429 };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          lastSeq: body.entries.at(-1)?.seq ?? -1,
          auditLastSeq: body.audit.entries.at(-1)?.seq ?? -1,
        }),
      };
    },
  });
  const flush: (options?: { keepalive?: boolean; final?: boolean; hidden?: boolean }) => Promise<void> | undefined =
    vm.runInContext(source + '\n_flushSyncLog', ctx);
  return {
    ring,
    posts,
    replies,
    deadlines,
    ctx,
    flush,
    rejectOnce: () => {
      busy = true;
    },
  };
}

test('stop freezes log, audit and credentials across a busy retry, late socket reply and a new match', async () => {
  const p = page(2);
  for (let i = 0; i < 5; i++) {
    p.ring.push({ t: i, f: i, msg: `row ${i}` });
    p.ctx._auditPending.push({ seq: i });
  }
  const epoch = p.ring.epoch;
  p.flush();
  assert.equal(p.replies.length, 1);
  assert.equal(p.posts.length, 0);
  p.rejectOnce();
  const stopped = p.flush({ final: true });
  assert.equal(p.posts.length, 1);
  p.ring.clear();
  p.ctx._cachedMatchId = 'match-B';
  p.ctx._cachedRoom = 'room B';
  p.ctx._cachedUploadToken = 'token B';
  p.ctx._auditEpoch = 'audit-B';
  p.ctx._auditPending = [{ seq: 0 }];
  p.replies[0]!(undefined);
  p.deadlines[0]!();
  await stopped;
  assert.deepEqual(p.posts[0], p.posts[1]);
  const accepted = p.posts.slice(1);
  assert.deepEqual(
    accepted.flatMap((r) => r.body.entries.map((v) => v.seq)),
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(
    accepted.flatMap((r) => r.body.audit.entries.map((v) => v.seq)),
    [0, 1, 2, 3, 4],
  );
  for (const r of accepted) {
    assert.equal(r.url, '/api/session-log?token=token%20A&room=room%20A');
    assert.equal(r.body.matchId, 'match-A');
    assert.equal(r.body.epoch, epoch);
    assert.equal(r.body.audit.epoch, 'audit-A');
    assert.equal(r.body.summary.frames, 44);
  }
  assert.equal(p.ctx._syncLogAckedSeq, -1);
  assert.equal(p.ctx._auditAckedSeq, -1);
  assert.deepEqual(p.ctx._auditPending, [{ seq: 0 }]);
  assert.equal(p.ctx._socketFlushFails, 0);
});

test('pagehide starts one byte-bounded upload of the newest logs and audit', async () => {
  const p = page(5000);
  for (let i = 0; i < 12; i++) {
    p.ring.push({ t: i, f: i, msg: '漢\u0000'.repeat(1400) });
    p.ctx._auditPending.push({ seq: i, detail: '漢'.repeat(1000) });
  }
  const done = p.flush({ keepalive: true });
  assert.equal(p.posts.length, 1);
  const [post] = p.posts;
  assert.ok(post!.keepalive && post!.bytes <= 56 * 1024);
  for (const [key, rows] of [
    ['logEntries', post!.body.entries],
    ['auditEntries', post!.body.audit.entries],
  ] as const) {
    assert.ok(rows.length > 0 && rows.length < 12);
    assert.deepEqual(
      rows.map(({ seq }) => seq),
      Array.from({ length: rows.length }, (_, i) => 12 - rows.length + i),
    );
    assert.equal(post!.body.summary.omittedOnExit?.[key], 12 - rows.length);
  }
  await done;
  assert.equal(p.posts.length, 1);
  assert.equal(p.replies.length, 0);
});

test('a hidden page sends an old prefix and may drain the rest after resuming', async () => {
  const p = page(5000);
  for (let i = 0; i < 10; i++) p.ring.push({ t: i, f: i, msg: 'x'.repeat(750) });
  await p.flush({ hidden: true });
  const [post] = p.posts;
  assert.ok(post!.keepalive && post!.bytes <= 4 * 1024);
  const prefix = post!.body.entries.map(({ seq }) => seq);
  assert.ok(prefix.length > 0 && prefix.length < 10);
  assert.deepEqual(
    prefix,
    Array.from({ length: prefix.length }, (_, i) => i),
  );
  await p.flush({ final: true });
  assert.deepEqual(
    p.posts.flatMap(({ body }) => body.entries.map(({ seq }) => seq)),
    Array.from({ length: 10 }, (_, i) => i),
  );
});

test('pagehide does not wait and retry a declined request', async () => {
  const p = page(10);
  p.ring.push({ t: 1, f: 1, msg: 'final row' });
  p.rejectOnce();
  await p.flush({ keepalive: true });
  assert.equal(p.posts.length, 1);
  assert.equal(p.ctx._syncLogAckedSeq, -1);
});
