import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const controller = readFileSync(new URL('../web/static/admin.js', import.meta.url), 'utf8');
const template = readFileSync(new URL('../web/admin.html', import.meta.url), 'utf8');
const domIds = new Set([...template.matchAll(/\bid="([\w-]+)"/g)].map((match) => match[1]));
const renderedIds = new Set(['tl-scroll-container', 'toast']);

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
  dataset = {};
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
  replaceChildren(...children) {
    this.textContent = '';
    this.children = children;
  }
}

const boot = (respond) => {
  const ui = new Map();
  const requests = [];
  const downloads = [];
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
      createObjectURL: () => 'blob:download',
      revokeObjectURL: () => {},
    },
    KNStorage: { get: () => 'fixture-key' },
    document: {
      querySelector: get,
      querySelectorAll: () => [],
      getElementById: (id) => get(`#${id}`),
      createElement: (tag) => {
        const element = new Element();
        if (tag === 'a') element.click = () => downloads.push([element.href, element.download]);
        if (tag === 'img')
          Object.defineProperty(element, 'src', {
            set(value) {
              element.dataUrl = value;
              element.onload?.();
            },
          });
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
    Blob,
    FileReader: class {
      readAsDataURL(blob) {
        assert.equal(blob.type, 'image/jpeg');
        this.result = 'data:image/jpeg;base64,fixture';
        this.onload();
      }
    },
    setTimeout: (fn) => fn(),
  });
  const open = (id) =>
    get('#session-log-list').click({
      closest: (selector) => (selector.startsWith('tr') ? { dataset: { sessionLogId: id } } : null),
    });
  return { get, open, requests, downloads };
};

test('row opens a summary immediately and never fetches raw log or screenshots until requested', async () => {
  const summary = pending();
  const { get, open, requests, downloads } = boot((path) => {
    if (path.endsWith('/summary')) return summary.response;
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events'))
      return json({
        match_id: 'match',
        events: [{ frame: 210, captured_frame: 300, capture_slots: [0, 1], vision_equal: false }],
      });
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
  assert.equal(verdicts.textContent, 'Desync not verified.');
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

test('only selected exact-frame images load with no URL key; each slot reports its own status', async () => {
  const { get, open, requests } = boot((path) => {
    if (path.endsWith('/summary')) return json({ id: 13, match_id: 'm' });
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events'))
      return json({
        match_id: 'm',
        events: [
          { frame: 300, vision_equal: false },
          { frame: 210, captured_frame: 300, capture_slots: [0, 0], vision_equal: false },
          { frame: 210, captured_frame: 300, capture_slots: [0, 1], vision_equal: null },
          { frame: 209, captured_frame: 299, capture_slots: [0, 1], vision_equal: false },
        ],
      });
    if (path.endsWith('/frame'))
      return json({
        frame: 300,
        previous_frame: 299,
        next_frame: 600,
        slots: [0, 1, 2, 3],
        screenshots: [
          { id: 1, slot: 0, frame: 300 },
          { id: 2, slot: 1, frame: 300 },
          { id: 3, slot: 2, frame: 300 },
        ],
      });
    if (path.endsWith('/img/1')) return { ok: true, blob: async () => 'jpeg' };
    if (path.endsWith('/img/2')) return { ok: false, status: 404 };
    if (path.endsWith('/img/3')) return error;
    throw new Error('unexpected request');
  });
  open('13');
  await tick();
  assert.equal(requests.filter(({ path }) => path.includes('/screenshots/')).length, 0);
  get('#captures-show').click();
  await tick();
  const host = get('#captures-content');
  assert.equal(host.children.length, 4);
  const [p0, p1, p2, p3] = host.children.map((slot) => slot.children[1]);
  assert.equal(p0.children[0].dataUrl, 'data:image/jpeg;base64,fixture');
  assert.equal(p1.textContent, 'Stored screenshot is missing.');
  assert.equal(p2.textContent, 'Could not load the screenshot.');
  assert.equal(p3.textContent, 'No exact capture at this frame.');
  assert.equal(get('#captures-verdict').textContent, ''); // not inherited from nearby f299
  const paths = requests.filter(({ path }) => path.includes('/img/'));
  assert.equal(paths.length, 3);
  assert.ok(paths.every(({ path, init }) => !path.includes('key=') && init.headers['X-Admin-Key'] === 'fixture-key'));
});

test('a vision result follows the captured frame, not the earlier suspect frame', async () => {
  const { get, open } = boot((path) => {
    if (path.endsWith('/summary')) return json({ id: 14, match_id: 'm' });
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events'))
      return json({
        match_id: 'm',
        events: [{ frame: 210, captured_frame: 300, capture_slots: [0, 1], vision_equal: false }],
      });
    if (path.includes('/screenshots/m/frame')) {
      const frame = path.endsWith('frame=300') ? 300 : 210;
      return json({
        frame,
        next_frame: frame === 210 ? 300 : null,
        slots: [0, 1],
        screenshots: [
          { id: 1, slot: 0, frame },
          { id: 2, slot: 1, frame },
        ],
      });
    }
    if (path.includes('/img/')) return { ok: true, blob: async () => 'jpeg' };
    throw new Error('unexpected request');
  });
  open('14');
  await tick();
  get('#captures-show').click();
  await tick();
  assert.equal(get('#captures-verdict').textContent, '');
  get('#captures-next').click();
  await tick();
  assert.equal(
    get('#captures-verdict').textContent,
    'A separate vision comparison flagged a mismatch in captures tagged frame 300.',
  );
});

test('seeking, reopening another match, and closing cancel outdated frame or image responses', async () => {
  const first = pending();
  const image = pending();
  const second = pending();
  const { get, open, requests } = boot((path) => {
    if (path.includes('/30/summary')) return json({ id: 30, match_id: 'm' });
    if (path.includes('/31/summary')) return json({ id: 31, match_id: 'm2' });
    if (path.includes('/session-timeline')) return error;
    if (path.includes('/desync-events')) return json({ match_id: path.split('match_id=')[1], events: [] });
    if (path.endsWith('/m/frame')) return first.response;
    if (path.endsWith('frame=2400'))
      return json({
        frame: 2400,
        slots: [0],
        screenshots: [],
        previous_frame: 1800,
        next_frame: 15000,
      });
    if (path.endsWith('frame=15000'))
      return json({
        frame: 15000,
        slots: [0],
        screenshots: [{ id: 1, slot: 0, frame: 15000 }],
      });
    if (path.endsWith('/img/1')) return image.response;
    if (path.endsWith('/m2/frame')) return second.response;
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
  assert.match(get('#captures-status').textContent, /No exact screenshots at frame 2400/);
  assert.equal(get('#captures-next').disabled, false);

  get('#captures-next').click();
  await tick();
  assert.equal(get('#captures-next').disabled, true);
  assert.ok(requests.some(({ path }) => path.endsWith('frame=15000')));
  const prevImage = requests.at(-1);
  assert.match(prevImage.path, /img\/1$/);
  open('31');
  assert.equal(prevImage.init.signal.aborted, true);
  await tick();
  get('#captures-show').click();
  const secondFrame = requests.at(-1);
  get('#viewer-close').click();
  assert.equal(secondFrame.init.signal.aborted, true);
  const stale = json({ frame: 299, slots: [0], screenshots: [{ id: 8, slot: 0, frame: 299 }] });
  first.reply(stale);
  second.reply(stale);
  image.reply({ ok: true, blob: async () => 'jpeg' });
  await tick();
  assert.equal(get('#captures-content').children.length, 0);
  assert.ok(!requests.some(({ path }) => path.endsWith('/img/8')));
});
