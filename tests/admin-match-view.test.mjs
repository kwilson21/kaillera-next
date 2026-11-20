import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const controller = readFileSync(new URL('../web/static/admin.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
const domIds = new Set([...template.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
const renderedIds = new Set([
  'comp-canvas',
  'comp-scrub',
  'comp-frame-label',
  'comp-play',
  'comp-prev',
  'comp-next',
  'screenshot-section',
  'tl-scroll-container',
  'toast',
]);

test('all static dashboard control IDs resolve against the real HTML or an explicit dynamic render', () => {
  const selectors = controller.matchAll(/(?:\$\('#|getElementById\(')([\w-]+)'/g);
  for (const [, id] of selectors) {
    assert.ok(domIds.has(id) || renderedIds.has(id), `missing admin view element #${id}`);
  }
  for (const id of renderedIds) {
    assert.match(controller, new RegExp(`(?:id="|\\.id = ')${id}["']`));
  }
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const json = (data) => ({ ok: true, json: async () => data });
const error = { ok: false, status: 500 };
const pending = () => {
  let reply;
  const response = new Promise((resolve) => (reply = resolve));
  return { response, reply };
};

class Element {
  events = new Map();
  children = [];
  hidden = new Set();
  classList = {
    add: (value) => this.hidden.add(value),
    remove: (value) => this.hidden.delete(value),
    contains: (value) => this.hidden.has(value),
    toggle: (value, condition) => (condition ? this.hidden.add(value) : this.hidden.delete(value)),
  };
  textContent = '';
  innerHTML = '';
  style = {};
  dataset = {};
  parent = null;
  badge = null;
  altReplacement = null;
  disabled = false;
  scrolls = 0;
  addEventListener(name, fn) {
    this.events.set(name, fn);
  }
  click(target = this) {
    return this.events.get('click')?.({ target, preventDefault() {}, stopPropagation() {} });
  }
  scrollIntoView() {
    this.scrolls++;
  }
  append(...children) {
    this.children.push(...children);
  }
  getContext() {
    return { fillRect() {}, fillText() {}, drawImage() {} };
  }
  remove() {}
  replaceWith(node) {
    this.altReplacement = node;
  }
  closest() {
    return this.parent;
  }
  querySelector() {
    return this.badge;
  }
  querySelectorAll() {
    if (this.lastHtml !== this.innerHTML) {
      this.lastHtml = this.innerHTML;
      this.thumbs = [...this.innerHTML.matchAll(/data-capture-id="(\d+)" data-bucket="(\d+)" data-slot="(\d+)"/g)].map(
        ([, id, bucket, slot]) => {
          const img = new Element();
          img.dataset = { captureId: id, bucket, slot };
          img.parent = new Element();
          img.parent.badge = new Element();
          return img;
        },
      );
    }
    return this.thumbs || [];
  }
}

const boot = (respond) => {
  const ui = new Map();
  const requests = [];
  const downloads = [];
  const observed = [];
  const blobs = [];
  const get = (id) => {
    if (id.startsWith('#')) assert.ok(domIds.has(id.slice(1)) || renderedIds.has(id.slice(1)), `unknown element ${id}`);
    if (!ui.has(id)) ui.set(id, new Element());
    return ui.get(id);
  };
  vm.runInNewContext(controller, {
    AbortController,
    Map,
    URLSearchParams,
    URL: {
      createObjectURL: () => `blob:screenshot/${blobs.push('pending')}`,
      revokeObjectURL: (url) => blobs.push(url),
    },
    KNStorage: { get: () => 'fixture-key' },
    document: {
      querySelector: get,
      querySelectorAll: () => [],
      getElementById: (id) => get(`#${id}`),
      createTextNode: (value) => value,
      createElement: (tag) => {
        const element = new Element();
        if (tag === 'a') element.click = () => downloads.push([element.href, element.download]);
        return element;
      },
    },
    window: { innerWidth: 1200 },
    fetch: (path, init) => {
      if (path === '/admin/api/stats') return Promise.resolve({ ok: false, status: 401 });
      requests.push({ path, init });
      return Promise.resolve(respond(path));
    },
    navigator: { clipboard: { writeText: async () => {} } },
    Image: Element,
    IntersectionObserver: class {
      constructor(callback) {
        this.visible = (elements) =>
          callback(
            elements.map((target) => ({ target, isIntersecting: true })),
            this,
          );
        observed.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    setInterval,
    clearInterval,
    setTimeout: (fn) => fn(),
  });
  const open = (id) =>
    get('#session-log-list').click({
      closest: (selector) => (selector.startsWith('tr') ? { dataset: { sessionLogId: id } } : null),
    });
  return { get, open, requests, downloads, observed, blobs };
};

const shotsFor = (min) =>
  Array.from({ length: 32 }, (_, i) => ({
    id: min + i,
    slot: i % 4,
    frame: Math.floor(i / 4) * 300 + 300,
    created_at: new Date(Date.UTC(2026, 10, 20, 0, 0, Math.floor(i / 4) * 5)).toISOString().slice(0, -1),
  }));

test('row opens a summary immediately and never fetches raw log or screenshots until requested', async () => {
  const summary = pending();
  const { get, open, requests, downloads } = boot((path) => {
    if (path.endsWith('/summary')) return summary.response;
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events'))
      return json({ events: [{ frame: 300, vision_equal: false, vision_confidence: 'high' }] });
    if (path.endsWith('/export')) return { ok: true, blob: async () => 'raw-jsonl' };
    throw new Error('unexpected request');
  });
  open('42');
  assert.equal(get('#log-viewer').scrolls, 1);
  assert.match(get('#viewer-content').textContent, /loading summary/i);
  assert.deepEqual(
    requests.map(({ path }) => path),
    ['/admin/api/session-logs/42/summary'],
  );
  summary.reply(json({ id: 42, match_id: 'match', room: 'room', summary: { duration_sec: 3600 } }));
  await tick();
  assert.match(get('#viewer-content').textContent, /duration_sec/);
  const [verdicts, timeline] = get('#viewer-extras').children;
  assert.match(timeline.textContent, /could not load/i);
  assert.match(verdicts.innerHTML, /VISION DESYNC DETECTED/);
  assert.equal(requests.length, 3);
  await get('#viewer-download').click();
  assert.equal(requests.at(-1).path, '/admin/api/session-logs/42/export');
  assert.equal(requests.at(-1).init.headers['X-Admin-Key'], 'fixture-key');
  assert.match(downloads[0][1], /session-42\.jsonl/);
});

test('cancels old views and never lets an old response overwrite the latest or closed view', async () => {
  const a = pending();
  const b = pending();
  const { get, open, requests } = boot((path) => (path.includes('/10/') ? a.response : b.response));
  open('10');
  open('20');
  assert.equal(requests[0].init.signal.aborted, true);
  b.reply(json({ room: '', player_name: 'Current' }));
  await tick();
  const latest = get('#viewer-content').textContent;
  a.reply(json({ room: 'old', player_name: 'Previous' }));
  await tick();
  assert.equal(get('#viewer-content').textContent, latest);
  assert.equal(requests.length, 2);
  get('#viewer-close').click();
  assert.equal(requests[1].init.signal.aborted, true);
  assert.equal(get('#log-viewer').classList.contains('hidden'), true);
});

test('capture range shares image reads between comparison and thumbnails, caps inflight reads, and aborts on close', async () => {
  const reads = [];
  const { get, open, requests, observed, blobs } = boot((path) => {
    if (path.endsWith('/summary')) return json({ id: 13, match_id: 'm' });
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events')) return json({ events: [] });
    if (path.includes('/window?'))
      return json({ screenshots: shotsFor(1), start_frame: 0, end_frame: 2249, next_frame: 2250 });
    if (path.includes('/img/')) {
      const request = pending();
      reads.push(request);
      return request.response;
    }
    throw new Error('unexpected request');
  });
  open('13');
  await tick();
  assert.equal(requests.filter(({ path }) => path.includes('/screenshots/')).length, 0);
  get('#captures-show').click();
  await tick();
  const host = get('#captures-content');
  assert.equal(host.querySelectorAll().length, 32);
  const firstRange = host.querySelectorAll();
  assert.ok(!host.innerHTML.includes('src='));
  assert.equal(requests.filter(({ path }) => path.includes('/window?')).length, 1);
  assert.equal(requests.filter(({ path }) => path.includes('/img/')).length, 4);
  observed[0].visible(firstRange);
  assert.equal(reads.length, 4);
  reads[0].reply(error);
  reads[1].reply({ ok: true, blob: async () => 'jpeg' });
  await tick();
  assert.equal(firstRange[0].altReplacement, 'Image unavailable');
  assert.match(firstRange.find((image) => image.dataset.captureId === '2').src, /^blob:/);
  assert.equal(reads.length, 6);
  const paths = requests.filter(({ path }) => path.includes('/img/'));
  assert.equal(new Set(paths.map(({ path }) => path)).size, 6);
  assert.ok(paths.every(({ path, init }) => !path.includes('key=') && init.headers['X-Admin-Key'] === 'fixture-key'));
  get('#viewer-close').click();
  assert.equal(observed[0].disconnected, true);
  assert.ok(paths.every(({ init }) => init.signal.aborted));
  assert.ok(blobs.some((entry) => entry.startsWith('blob:')));
  for (const request of reads.slice(2)) request.reply({ ok: true, blob: async () => 'jpeg' });
  await tick();
  assert.equal(reads.length, 6);
  assert.equal(host.innerHTML, '');
});

test('seeking again discards a slow range, and earlier/later follows server captures across gaps', async () => {
  const slow = pending();
  const { get, open, requests } = boot((path) => {
    if (path.endsWith('/summary')) return json({ id: 30, match_id: 'm' });
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events')) return json({ events: [] });
    if (path.endsWith('frame=0')) return slow.response;
    if (path.endsWith('frame=2400')) {
      return json({ screenshots: [], previous_frame: 1800, next_frame: 15000, start_frame: 2250, end_frame: 4649 });
    }
    if (path.endsWith('frame=15000')) {
      return json({ screenshots: [], previous_frame: 1800, start_frame: 14250, end_frame: 16649 });
    }
    throw new Error('unexpected request');
  });
  open('30');
  await tick();
  get('#captures-show').click();
  const initial = requests.at(-1);
  get('#capture-seek').value = '2400';
  get('#captures-seek').events.get('submit')({ preventDefault() {} });
  assert.equal(initial.init.signal.aborted, true);
  await tick();
  assert.equal(get('#captures-next').classList.contains('hidden'), false);
  get('#captures-next').click();
  await tick();
  assert.match(requests.at(-1).path, /frame=15000$/);
  assert.equal(get('#captures-next').classList.contains('hidden'), true);
  slow.reply(json({ screenshots: shotsFor(1), start_frame: 0, end_frame: 2249 }));
  await tick();
  assert.equal(get('#captures-content').innerHTML, '');
  assert.ok(requests.every(({ path }) => !path.includes('/img/')));
});
