import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { chromium } from 'playwright';

const source = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const slice = (text, first, last) => {
  const start = text.indexOf(first);
  const end = text.indexOf(last, start);
  assert.ok(start >= 0 && end > start);
  return text.slice(start, end);
};

function checkPagehide(persisted) {
  return async (t) => {
    const rules = buildSync({
      entryPoints: [fileURLToPath(new URL('../web/src/session-log-keepalive.ts', import.meta.url))],
      bundle: true,
      format: 'iife',
      globalName: 'logRules',
      write: false,
    }).outputFiles[0].text;
    const engine = slice(
      source('../web/static/netplay-rollback.js'),
      '  const _buildFlushPayload',
      '  // -- Canvas pixel hash',
    );
    const pagehide = slice(
      source('../web/static/play.js'),
      "  window.addEventListener('pagehide'",
      '  // ── Socket.IO',
    );
    const code = `
    ${rules}
    const KNCore = window.KNCore = logRules;
    const KNState = { peers: null };
    const rows = Array.from({ length: 12 }, (_, seq) => ({ seq, t: seq, f: seq, msg: 'x'.repeat(14000) }));
    const _syncLogRing = { epoch: 'log', entriesAfter: () => rows };
      const SYNC_LOG_FLUSH_MAX_ENTRIES = 5000, AUDIT_FLUSH_MAX = 5000;
    const _auditPending = [], _auditEpoch = 'audit';
    let _syncLogAckedSeq = -1, _auditAckedSeq = -1;
    const _cachedMatchId = 'match', _cachedRoom = 'room', _cachedUploadToken = 'token';
    const socket = null, _frameNum = 20, _startTime = 0, _useCRollback = false;
    const _modeName = () => 'rollback', _buildRollbackStats = () => null;
    const _peerBoundary = () => ({ ack: (_, data) => data });
    ${engine}
    const engine = { exportSyncLog: () => '', flushSyncLog: _flushSyncLog };
    ${pagehide}
  `;
    let resolveUpload;
    const received = new Promise((resolve) => {
      resolveUpload = resolve;
    });
    let acknowledge;
    const collector = createServer((request, response) => {
      if (request.url?.startsWith('/api/session-log?')) {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const payload = JSON.parse(body);
          // Keep the ack outstanding until the test has confirmed navigation.
          acknowledge = () => {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ lastSeq: payload.entries.at(-1)?.seq ?? -1, auditLastSeq: -1 }));
          };
          resolveUpload({ bytes: Buffer.byteLength(body), payload });
        });
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        response.end(request.url === '/' ? `<script>${code}</script>` : '<title>Replacement</title>');
      }
    });
    collector.listen(0, '127.0.0.1');
    t.after(() => {
      collector.closeAllConnections();
      collector.close();
    });
    await once(collector, 'listening');
    const origin = 'http://127.0.0.1:' + collector.address().port;
    const browser = await chromium.launch({
      ...(process.env.KN_CHROMIUM ? { executablePath: process.env.KN_CHROMIUM } : {}),
      args: ['--disable-back-forward-cache'],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(origin);
    if (persisted) {
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    } else {
      await page.goto(origin + '/replacement');
      assert.equal(await page.title(), 'Replacement');
    }
    const upload = await received;
    assert.ok(upload.bytes <= 56 * 1024);
    assert.deepEqual(
      upload.payload.entries.map(({ seq }) => seq),
      [8, 9, 10, 11],
    );
    assert.deepEqual(upload.payload.summary.omittedOnExit, { logEntries: 8, auditEntries: 0 });
    acknowledge();
  };
}

test('a discarded document keeps the newest session log batch', { timeout: 20000 }, checkPagehide(false));
test('a cached document keeps the newest session log batch', { timeout: 20000 }, checkPagehide(true));
