import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  changeHtml,
  decodeChangelog,
  decodeVersionFile,
  dedicationLine,
  escapeHtml,
  startVersion,
  type SiteStyle,
  type StaticJson,
  type VersionHost,
} from '../../web/src/site/version.ts';

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/version.js as of #166, unchanged.
const OLD_SCRIPT = `/**
 * version.js — Version Display + Changelog Modal
 *
 * Fetches version.json and changelog.json, renders the current version
 * in the page footer, and provides a changelog modal with version
 * dedications. Loaded after play.js on the game page.
 *
 * Consumed by: play.html, index.html
 * Exposes: nothing (self-contained IIFE)
 */
(() => {
  let _changelog = null;
  let _currentVersion = null;

  const VERSION_DEDICATIONS = {
    '0.21.0': "Agent's Version",
  };

  const fetchVersion = async () => {
    for (const el of document.querySelectorAll('#kn-about')) {
      el.addEventListener('click', showAbout);
    }
    try {
      const res = await fetch(\`/static/version.json?_t=\${Date.now()}\`);
      const data = await res.json();
      _currentVersion = data.version;
      for (const el of document.querySelectorAll('#kn-version')) {
        el.textContent = \`v\${data.version}\`;
        el.addEventListener('click', showChangelog);
      }
    } catch (_) {}
  };

  const showChangelog = async () => {
    if (!_changelog) {
      try {
        const res = await fetch(\`/static/changelog.json?_t=\${Date.now()}\`);
        _changelog = await res.json();
      } catch (_) {
        return;
      }
    }
    renderModal(_changelog);
  };

  const renderModal = (changelog) => {
    // Remove existing modal if any
    document.getElementById('kn-changelog-modal')?.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'kn-changelog-modal';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '99999',
      padding: '20px',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#1a1a2e',
      border: '1px solid #333',
      borderRadius: '12px',
      maxWidth: '520px',
      width: '100%',
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '24px',
      color: '#ccc',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px',
    });
    const title = document.createElement('h2');
    title.textContent = 'Changelog';
    Object.assign(title.style, { margin: '0', color: '#fff', fontSize: '18px' });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\\u00d7';
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      color: '#888',
      fontSize: '24px',
      cursor: 'pointer',
      padding: '0 4px',
    });
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.append(title, closeBtn);
    card.appendChild(header);

    // Versions
    changelog.forEach((release, i) => {
      const section = document.createElement('div');
      section.style.marginBottom = '12px';

      const vHeader = document.createElement('div');
      Object.assign(vHeader.style, {
        cursor: 'pointer',
        padding: '8px 0',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      });

      const vLabel = document.createElement('span');
      vLabel.innerHTML = \`<strong style="color:#fff">v\${escapeHtml(release.version)}</strong> <span style="color:#666;margin-left:8px">\${escapeHtml(release.date)}</span>\`;
      const arrow = document.createElement('span');
      arrow.textContent = i === 0 ? '\\u25BC' : '\\u25B6';
      arrow.style.color = '#666';
      vHeader.append(vLabel, arrow);

      const list = document.createElement('ul');
      Object.assign(list.style, {
        margin: '8px 0 0 0',
        padding: '0 0 0 20px',
        display: i === 0 ? 'block' : 'none',
      });

      for (const change of release.changes) {
        const li = document.createElement('li');
        li.style.marginBottom = '4px';
        const prefix =
          change.type === 'feat'
            ? '<span style="color:#4ade80">+</span> '
            : '<span style="color:#f59e0b">\\u2022</span> ';
        li.innerHTML = prefix + escapeHtml(change.message);
        list.appendChild(li);
      }

      vHeader.addEventListener('click', () => {
        const visible = list.style.display !== 'none';
        list.style.display = visible ? 'none' : 'block';
        arrow.textContent = visible ? '\\u25B6' : '\\u25BC';
      });

      section.append(vHeader, list);
      card.appendChild(section);
    });

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Close on backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  };

  const escapeHtml = (s) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, (c) => map[c]);
  };

  // ── About modal ──────────────────────────────────────────────────────

  const LINEAGE = [
    ['Kaillera (2001)', 'Christophe Thibault'],
    ['EmuLinker', 'Moosehead'],
    ['EmuLinker SF', 'Suprafast'],
    ['SupraClient', 'Suprafast'],
    ['n02 p2p', 'Jugoso, Killer Civilian'],
    ['Project64k', 'Hotquik'],
    ['AQZ NetPlay', 'CoderTimZ, CEnnis91'],
    ['Ownasaurus Client', 'Ownasaurus'],
    ['EmuLinker X', 'Near, Firo, Ownasaurus, Agent 21'],
    ['EmuLinker-K', 'hopskipnfall'],
    ['Kaillera Reborn', 'God-Weapon & community'],
    ['kaillera-next', 'Agent 21'],
  ];

  const STORY_PARAGRAPHS = [
    \`It started at my grandparents' house. I was bored with nothing to do when my grandfather asked if I wanted to play Sonic. There was no Sega in sight — he pointed me to the PC. A data CD on the desk had a Sega emulator and some ROMs. I figured out how to set it up and played Sonic on an emulator for the first time.\`,
    \`A year or two later, I got curious at home and found the same emulator online. That led me to Project64, where I discovered I could play Super Smash Bros. 64 — a game I'd only played once as a kid and always wanted to play again.\`,
    \`Then I found the netplay tab. That's how I discovered Kaillera — and started playing SSB64 online with people from all over. I made a lot of friends through that community.\`,
    \`I always wanted to fix the problems with the emulator, the server, and the clients. But I was only 9 to 12 years old. Learning C++ and Java felt impossible. I got involved with the community efforts to improve things as best I could, eventually moved on, but never forgot about it.\`,
    \`Now, with the help of AI, I'm finally building what I always wanted Kaillera to be.\`,
  ];

  const showAbout = () => {
    document.getElementById('kn-about-modal')?.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'kn-about-modal';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '99999',
      padding: '20px',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#1a1a2e',
      border: '1px solid #333',
      borderRadius: '12px',
      maxWidth: '520px',
      width: '100%',
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '24px',
      color: '#ccc',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px',
    });
    const title = document.createElement('h2');
    title.textContent = 'kaillera-next';
    Object.assign(title.style, { margin: '0', color: '#c9a227', fontSize: '20px' });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\\u00d7';
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      color: '#888',
      fontSize: '24px',
      cursor: 'pointer',
      padding: '0 4px',
    });
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.append(title, closeBtn);
    card.appendChild(header);

    // Version dedication
    const dedication = VERSION_DEDICATIONS[_currentVersion];
    if (dedication) {
      const dedLine = document.createElement('div');
      dedLine.textContent = \`v\${_currentVersion} \\u2014 \${dedication}\`;
      Object.assign(dedLine.style, {
        color: '#c9a227',
        fontSize: '13px',
        marginBottom: '16px',
        fontStyle: 'italic',
      });
      card.appendChild(dedLine);
    }

    // Lineage
    const lineageEl = document.createElement('div');
    lineageEl.style.marginBottom = '16px';
    for (const [project, author] of LINEAGE) {
      const row = document.createElement('div');
      row.style.marginBottom = '4px';
      row.innerHTML = \`<strong style="color:#fff">\${escapeHtml(project)}</strong> <span style="color:#888">\\u2014 \${escapeHtml(author)}</span>\`;
      lineageEl.appendChild(row);
    }
    const communityLine = document.createElement('div');
    communityLine.textContent = '...and the countless others who kept Kaillera alive';
    Object.assign(communityLine.style, { color: '#666', fontStyle: 'italic', marginTop: '8px' });
    lineageEl.appendChild(communityLine);
    card.appendChild(lineageEl);

    // Links
    const links = document.createElement('div');
    Object.assign(links.style, { marginBottom: '16px', display: 'flex', gap: '16px' });
    for (const [label, url] of [
      ['GitHub', 'https://github.com/kwilson21/kaillera-next'],
      ['Support (Ko-fi)', 'https://ko-fi.com/kazonwilson'],
    ]) {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      Object.assign(a.style, { color: '#c9a227', textDecoration: 'none', fontSize: '13px' });
      links.appendChild(a);
    }
    card.appendChild(links);

    // Expandable story
    const storyHeader = document.createElement('div');
    Object.assign(storyHeader.style, {
      cursor: 'pointer',
      padding: '8px 0',
      borderTop: '1px solid #333',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    });
    const storyLabel = document.createElement('span');
    storyLabel.textContent = 'The Story';
    storyLabel.style.color = '#fff';
    const storyArrow = document.createElement('span');
    storyArrow.textContent = '\\u25B6';
    storyArrow.style.color = '#666';
    storyHeader.append(storyLabel, storyArrow);

    const storyBody = document.createElement('div');
    storyBody.style.display = 'none';
    for (const text of STORY_PARAGRAPHS) {
      const p = document.createElement('p');
      p.textContent = text;
      Object.assign(p.style, { margin: '0 0 10px 0', lineHeight: '1.5', color: '#aaa' });
      storyBody.appendChild(p);
    }

    storyHeader.addEventListener('click', () => {
      const visible = storyBody.style.display !== 'none';
      storyBody.style.display = visible ? 'none' : 'block';
      storyArrow.textContent = visible ? '\\u25B6' : '\\u25BC';
    });

    card.append(storyHeader, storyBody);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchVersion);
  } else {
    fetchVersion();
  }
})();
`;

/** JSON as the page gets it from `response.json()`. */
const parseJson = (text: string): StaticJson => JSON.parse(text);

const blankStyle = (): SiteStyle => ({
  position: '',
  inset: '',
  background: '',
  display: '',
  alignItems: '',
  justifyContent: '',
  zIndex: '',
  padding: '',
  border: '',
  borderRadius: '',
  maxWidth: '',
  width: '',
  maxHeight: '',
  overflow: '',
  color: '',
  fontFamily: '',
  fontSize: '',
  fontStyle: '',
  margin: '',
  marginBottom: '',
  marginTop: '',
  cursor: '',
  borderBottom: '',
  borderTop: '',
  gap: '',
  textDecoration: '',
  lineHeight: '',
});

/** What a listener on a fake element is called with. */
interface FakeEvent {
  readonly target: object | null;
  readonly key: string;
}
type FakeListener = (event: FakeEvent) => void;

/** What a test compares of an element: everything either version can set on it. */
interface Snapshot {
  readonly tag: string;
  readonly id: string;
  readonly text: string | null;
  readonly html: string;
  readonly style: SiteStyle;
  readonly attributes: readonly (readonly [string, string])[];
  readonly clickListeners: number;
  readonly children: readonly Snapshot[];
}

/** An element both versions build with. Reflected properties (`href`, …) and attributes are one store, as in a browser. */
class FakeElement {
  id = '';
  textContent: string | null = '';
  innerHTML = '';
  readonly style = blankStyle();
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly clicks: FakeListener[] = [];
  parent: FakeElement | null = null;
  readonly tag: string;

  constructor(tag: string) {
    this.tag = tag;
  }

  set href(value: string) {
    this.attributes.set('href', value);
  }
  set target(value: string) {
    this.attributes.set('target', value);
  }
  set rel(value: string) {
    this.attributes.set('rel', value);
  }

  readonly setAttribute = (name: string, value: string): void => {
    this.attributes.set(name, value);
  };
  readonly addEventListener = (type: string, listener: FakeListener): void => {
    assert.equal(type, 'click');
    this.clicks.push(listener);
  };
  readonly appendChild = (child: FakeElement): void => {
    child.remove();
    child.parent = this;
    this.children.push(child);
  };
  readonly append = (...children: FakeElement[]): void => {
    for (const child of children) this.appendChild(child);
  };
  readonly remove = (): void => {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  };

  /** This element and everything under it, in document order. */
  all(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  /** This element, then its ancestors up to the body. */
  path(): FakeElement[] {
    return [this, ...(this.parent?.path() ?? [])];
  }

  /** Click it: its own listeners, then its ancestors', as a bubbling click does. */
  click(): void {
    for (const at of this.path()) {
      for (const listener of at.clicks) listener({ target: this, key: '' });
    }
  }

  snapshot(): Snapshot {
    return {
      tag: this.tag,
      id: this.id,
      text: this.textContent,
      html: this.innerHTML,
      style: { ...this.style },
      attributes: [...this.attributes].sort(([a], [b]) => a.localeCompare(b)),
      clickListeners: this.clicks.length,
      children: this.children.map((child) => child.snapshot()),
    };
  }
}

/** What the server answers for one of the two files: its text, or 'down' for a request that fails. */
type FileAnswer = string;
const DOWN = 'down';

const fakePage = (readyState: 'loading' | 'complete', controls: { about: number; version: number }) => {
  const body = new FakeElement('body');
  const about = Array.from({ length: controls.about }, () => new FakeElement('button'));
  const version = Array.from({ length: controls.version }, () => new FakeElement('button'));
  for (const control of [...about, ...version]) body.appendChild(control);
  const documentListeners = new Map<string, FakeListener[]>();
  const answers = new Map<string, FileAnswer>([
    ['/static/version.json', DOWN],
    ['/static/changelog.json', DOWN],
  ]);
  const fetched: string[] = [];
  const document = {
    readyState,
    body,
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => body.all().find((element) => element.id === id) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '#kn-about') return about;
      assert.equal(selector, '#kn-version');
      return version;
    },
    addEventListener: (type: string, listener: FakeListener) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), listener]);
    },
    removeEventListener: (type: string, listener: FakeListener) => {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter((held) => held !== listener),
      );
    },
  };
  const fetch = (url: string) => {
    // The cache-busting stamp is the clock's; what is asked for is the path.
    const path = url.replace(/\?_t=\d+$/, '');
    assert.notEqual(path, url, 'every request carries a cache-busting stamp');
    fetched.push(path);
    const answer = answers.get(path) ?? DOWN;
    if (answer === DOWN) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ json: async () => parseJson(answer) });
  };
  return {
    document,
    fetch,
    body,
    about,
    version,
    fetched,
    setAnswer: (path: string, answer: FileAnswer): void => {
      answers.set(path, answer);
    },
    /** Fire a document event at every listener for it. */
    fire: (type: string, key = ''): void => {
      for (const listener of documentListeners.get(type) ?? []) listener({ target: null, key });
    },
    /** Everything a test compares: the tree, the requests, and how many document listeners are held. */
    state: () => ({
      tree: body.snapshot(),
      fetched: [...fetched],
      keydownListeners: (documentListeners.get('keydown') ?? []).length,
    }),
  };
};

type Page = ReturnType<typeof fakePage>;

const startOld = (page: Page): void => {
  vm.runInNewContext(OLD_SCRIPT, { document: page.document, fetch: page.fetch, Date });
};

const startNew = (page: Page): void => {
  const host: VersionHost<FakeElement> = { document: page.document, fetch: page.fetch };
  startVersion(host);
};

/** Let requests in flight finish: each is a fetch and a json(), both already settled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};

const rng = (seed: number) => {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return Math.floor((s / 0x1_0000_0000) * n);
  };
};

const CHANGELOG = JSON.stringify([
  {
    version: '0.3.0',
    date: '2026-03-02',
    changes: [
      { type: 'feat', message: 'rooms <b>&</b> "boards"' },
      { type: 'fix', message: "the host's name" },
    ],
  },
  { version: '0.2.1', date: '2026-02-11', changes: [{ type: 'chore', message: 'tidy' }] },
  { version: '0.2.0', date: '2026-02-01', changes: [] },
]);

const VERSION_ANSWERS: readonly FileAnswer[] = [
  DOWN,
  'not json',
  'null',
  '{"version":"0.68.5","commit":"3cb8bae"}',
  '{"version":"0.21.0"}',
  '{"version":""}',
];
const CHANGELOG_ANSWERS: readonly FileAnswer[] = [DOWN, 'not json', CHANGELOG, CHANGELOG, '[]'];

/** One thing a visitor or the server does. The same picks drive the old page and the new. */
const step = (page: Page, pick: (n: number) => number): string => {
  const kind = pick(8);
  if (kind === 0) {
    const control = page.about[pick(page.about.length)];
    control?.click();
    return 'about';
  }
  if (kind === 1) {
    const control = page.version[pick(page.version.length)];
    control?.click();
    return 'version';
  }
  if (kind === 2) {
    const answer = CHANGELOG_ANSWERS[pick(CHANGELOG_ANSWERS.length)] ?? DOWN;
    page.setAnswer('/static/changelog.json', answer);
    return `changelog=${answer.slice(0, 12)}`;
  }
  if (kind === 3) {
    page.fire('keydown', pick(2) === 0 ? 'Escape' : 'a');
    return 'key';
  }
  // Anything in an open window that can be clicked: its close button, a
  // release's header, the story's header, the backdrop, or text inside it.
  const inWindows = page.body.children.filter((child) => child.id !== '').flatMap((child) => child.all());
  const clicked = inWindows[pick(Math.max(inWindows.length, 1))];
  clicked?.click();
  return `click ${clicked?.tag ?? 'nothing'}`;
};

test('both windows and the footer match the old script, over random sequences', async () => {
  let changelogsShown = 0;
  let aboutsShown = 0;
  let dedications = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const pick = rng(seed);
    const readyState = pick(4) === 0 ? 'loading' : 'complete';
    const controls = { about: pick(3), version: pick(3) };
    const versionAnswer = VERSION_ANSWERS[pick(VERSION_ANSWERS.length)] ?? DOWN;
    const pages = [fakePage(readyState, controls), fakePage(readyState, controls)] as const;
    const pickers = [rng(seed * 104729), rng(seed * 104729)] as const;
    for (const page of pages) page.setAnswer('/static/version.json', versionAnswer);
    startOld(pages[0]);
    startNew(pages[1]);
    await settle();
    assert.deepEqual(pages[1].state(), pages[0].state(), `seed ${seed} before the document is ready`);
    for (const page of pages) page.fire('DOMContentLoaded');
    await settle();
    const script: string[] = [];
    for (let i = 0; i < 30; i++) {
      script.push(step(pages[0], pickers[0]));
      step(pages[1], pickers[1]);
      await settle();
      assert.deepEqual(pages[1].state(), pages[0].state(), `seed ${seed} after ${script.join(' | ')}`);
      const open = pages[1].body.children.map((child) => child.id);
      if (open.includes('kn-changelog-modal')) changelogsShown++;
      if (open.includes('kn-about-modal')) aboutsShown++;
      if (pages[1].body.all().some((element) => element.textContent === "v0.21.0 — Agent's Version")) {
        dedications++;
      }
    }
  }
  // The sequences open both windows often, so the comparison is not of empty pages.
  assert.ok(changelogsShown > 200, `changelog open in ${changelogsShown} states`);
  assert.ok(aboutsShown > 200, `about open in ${aboutsShown} states`);
  assert.ok(dedications > 20, `dedication shown in ${dedications} states`);
});

test('the footer shows the version and opens the changelog, newest release unfolded', async () => {
  const page = fakePage('complete', { about: 1, version: 1 });
  page.setAnswer('/static/version.json', '{"version":"0.3.0"}');
  page.setAnswer('/static/changelog.json', CHANGELOG);
  startNew(page);
  await settle();
  assert.equal(page.version[0]?.textContent, 'v0.3.0');
  page.version[0]?.click();
  await settle();
  const modal = page.body.children.find((child) => child.id === 'kn-changelog-modal');
  assert.ok(modal);
  const lists = modal.all().filter((element) => element.tag === 'ul');
  assert.deepEqual(
    lists.map((list) => list.style.display),
    ['block', 'none', 'none'],
  );
  assert.deepEqual(
    lists[0]?.children.map((item) => item.innerHTML),
    [
      '<span style="color:#4ade80">+</span> rooms &lt;b&gt;&amp;&lt;/b&gt; &quot;boards&quot;',
      '<span style="color:#f59e0b">•</span> the host&#39;s name',
    ],
  );
  // The changelog is fetched once; opening it again reuses it.
  page.version[0]?.click();
  await settle();
  assert.deepEqual(page.fetched, ['/static/version.json', '/static/changelog.json']);
  assert.equal(page.body.children.filter((child) => child.id === 'kn-changelog-modal').length, 1);
});

test('About opens with the server down', async () => {
  const page = fakePage('complete', { about: 1, version: 1 });
  startNew(page);
  await settle();
  assert.equal(page.version[0]?.textContent, '');
  page.about[0]?.click();
  const modal = page.body.children.find((child) => child.id === 'kn-about-modal');
  assert.ok(modal);
  const links = modal.all().filter((element) => element.tag === 'a');
  assert.deepEqual(
    links.map((link) => [link.textContent, Object.fromEntries(link.attributes)]),
    [
      ['GitHub', { href: 'https://github.com/kwilson21/kaillera-next', rel: 'noopener', target: '_blank' }],
      ['Support (Ko-fi)', { href: 'https://ko-fi.com/kazonwilson', rel: 'noopener', target: '_blank' }],
    ],
  );
  page.fire('keydown', 'Escape');
  assert.equal(page.body.children.filter((child) => child.id !== '').length, 0);
});

test('a version file off its shape leaves the footer as a failed request does', async () => {
  for (const answer of ['{}', '{"version":7}', '{"version":null}', '[]', '"0.3.0"', '7', '[{"version":"0.3.0"}]']) {
    assert.equal(decodeVersionFile(parseJson(answer)), null, answer);
    const page = fakePage('complete', { about: 1, version: 1 });
    page.setAnswer('/static/version.json', answer);
    startNew(page);
    await settle();
    assert.equal(page.version[0]?.textContent, '', answer);
    assert.equal(page.version[0]?.clicks.length, 0, answer);
    assert.equal(page.about[0]?.clicks.length, 1, answer);
  }
  assert.equal(decodeVersionFile(parseJson('{"version":"0.3.0","commit":"abc"}')), '0.3.0');
});

test('a changelog off its shape opens nothing and is asked for again on the next click', async () => {
  const malformed = [
    '{}',
    'null',
    '"changes"',
    '[null]',
    '[{"version":"1","date":"d"}]',
    '[{"version":1,"date":"d","changes":[]}]',
    '[{"version":"1","date":null,"changes":[]}]',
    '[{"version":"1","date":"d","changes":{}}]',
    '[{"version":"1","date":"d","changes":[{"type":"fix"}]}]',
    '[{"version":"1","date":"d","changes":[{"type":1,"message":"m"}]}]',
    '[{"version":"1","date":"d","changes":["m"]}]',
  ];
  for (const answer of malformed) {
    assert.equal(decodeChangelog(parseJson(answer)), null, answer);
    const page = fakePage('complete', { about: 0, version: 1 });
    page.setAnswer('/static/version.json', '{"version":"0.3.0"}');
    page.setAnswer('/static/changelog.json', answer);
    startNew(page);
    await settle();
    page.version[0]?.click();
    await settle();
    assert.equal(page.body.children.filter((child) => child.id !== '').length, 0, answer);
    page.setAnswer('/static/changelog.json', CHANGELOG);
    page.version[0]?.click();
    await settle();
    assert.equal(page.body.children.filter((child) => child.id === 'kn-changelog-modal').length, 1, answer);
    assert.equal(page.fetched.filter((path) => path === '/static/changelog.json').length, 2);
  }
});

test('the files the server ships decode', () => {
  const read = (name: string): StaticJson =>
    parseJson(readFileSync(new URL(`../../web/static/${name}`, import.meta.url), 'utf8'));
  const version = decodeVersionFile(read('version.json'));
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/);
  const changelog = decodeChangelog(read('changelog.json'));
  assert.ok(changelog !== null && changelog.length > 0);
  assert.equal(changelog[0]?.version, version);
});

test('the pure pieces', () => {
  // escapeHtml of web/static/version.js as of #166.
  const oldEscapeHtml = (s: string): string => {
    const map = new Map([
      ['&', '&amp;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"', '&quot;'],
      ["'", '&#39;'],
    ]);
    return String(s).replace(/[&<>"']/g, (c) => map.get(c) ?? c);
  };
  for (const text of ['', 'plain', '<script>alert("x")</script>', "it's & it isn't", '&amp;', '— <<>>']) {
    assert.equal(escapeHtml(text), oldEscapeHtml(text));
  }
  assert.equal(changeHtml({ type: 'feat', message: 'a<b' }), '<span style="color:#4ade80">+</span> a&lt;b');
  assert.equal(changeHtml({ type: 'fix', message: 'c' }), '<span style="color:#f59e0b">•</span> c');
  assert.equal(dedicationLine('0.21.0'), "v0.21.0 — Agent's Version");
  assert.equal(dedicationLine('0.21.1'), null);
  assert.equal(dedicationLine(null), null);
});

test('a real window is a host the version display accepts', () => {
  // The caller in web/static is plain script, so the compiler checks the fit here.
  const fits: typeof window extends VersionHost<HTMLElement> ? true : false = true;
  assert.ok(fits);
});
