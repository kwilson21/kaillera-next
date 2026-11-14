/**
 * The version in the page footer, the changelog it opens, and the About
 * window. Moved from web/static/version.js.
 *
 * `#kn-version` is filled from `/static/version.json` and opens the
 * changelog (`/static/changelog.json`, fetched on the first click).
 * `#kn-about` opens the About window, which needs no request and so works
 * while the server is asleep.
 */

/** A JSON value that is not an object or a list. */
export type JsonScalar = string | number | boolean | null;

/**
 * An object from one of the two files before it is checked: the fields this
 * module reads, any of which can hold anything.
 */
export interface UncheckedFields {
  readonly version?: unknown;
  readonly date?: unknown;
  readonly changes?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
}

/** Whatever JSON one of the two files turned out to hold. */
export type StaticJson = JsonScalar | UncheckedFields | (JsonScalar | UncheckedFields)[];

/** One line of a release. `type` is the commit's kind: 'feat', 'fix', … */
export interface Change {
  readonly type: string;
  readonly message: string;
}

/** One release in the changelog. */
export interface Release {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly Change[];
}

const fieldsOf = (data: StaticJson): UncheckedFields | null =>
  typeof data !== 'object' || data === null || Array.isArray(data) ? null : data;

/** The version in `/static/version.json`: `{version: string}`. Anything else is null. */
export const decodeVersionFile = (data: StaticJson): string | null => {
  const version = fieldsOf(data)?.version;
  return typeof version === 'string' ? version : null;
};

const decodeChange = (data: StaticJson): Change | null => {
  const fields = fieldsOf(data);
  return typeof fields?.type === 'string' && typeof fields.message === 'string'
    ? { type: fields.type, message: fields.message }
    : null;
};

const decodeRelease = (data: StaticJson): Release | null => {
  const fields = fieldsOf(data);
  if (typeof fields?.version !== 'string' || typeof fields.date !== 'string') return null;
  if (!Array.isArray(fields.changes)) return null;
  const changes: Change[] = [];
  for (const entry of fields.changes) {
    const change = decodeChange(entry);
    if (change === null) return null;
    changes.push(change);
  }
  return { version: fields.version, date: fields.date, changes };
};

/**
 * `/static/changelog.json`: a list of releases, newest first. A file with
 * any entry off that shape is null as a whole.
 */
export const decodeChangelog = (data: StaticJson): readonly Release[] | null => {
  if (!Array.isArray(data)) return null;
  const releases: Release[] = [];
  for (const entry of data) {
    const release = decodeRelease(entry);
    if (release === null) return null;
    releases.push(release);
  }
  return releases;
};

const ESCAPES = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
]);

/** Text made safe to put in markup. */
export const escapeHtml = (text: string): string => text.replaceAll(/[&<>"']/g, (c) => ESCAPES.get(c) ?? c);

/** Versions with a name of their own, shown at the top of the About window. */
const VERSION_DEDICATIONS = new Map([['0.21.0', "Agent's Version"]]);

/** The dedication line of a version, or null when it has none. */
export const dedicationLine = (version: string | null): string | null => {
  const dedication = version === null ? undefined : VERSION_DEDICATIONS.get(version);
  return dedication ? `v${version} — ${dedication}` : null;
};

/** The header of one release: its version, then its date. */
export const releaseHeadingHtml = (release: Release): string =>
  `<strong style="color:#fff">v${escapeHtml(release.version)}</strong> <span style="color:#666;margin-left:8px">${escapeHtml(release.date)}</span>`;

/** One line of a release: a green plus for a feature, an amber dot for anything else. */
export const changeHtml = (change: Change): string =>
  (change.type === 'feat' ? '<span style="color:#4ade80">+</span> ' : '<span style="color:#f59e0b">•</span> ') +
  escapeHtml(change.message);

/** The projects kaillera-next descends from, oldest first, with who made them. */
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
] as const;

/** One row of the lineage. */
export const lineageHtml = (project: string, author: string): string =>
  `<strong style="color:#fff">${escapeHtml(project)}</strong> <span style="color:#888">— ${escapeHtml(author)}</span>`;

const LINKS = [
  ['GitHub', 'https://github.com/kwilson21/kaillera-next'],
  ['Support (Ko-fi)', 'https://ko-fi.com/kazonwilson'],
] as const;

const STORY_PARAGRAPHS = [
  `It started at my grandparents' house. I was bored with nothing to do when my grandfather asked if I wanted to play Sonic. There was no Sega in sight — he pointed me to the PC. A data CD on the desk had a Sega emulator and some ROMs. I figured out how to set it up and played Sonic on an emulator for the first time.`,
  `A year or two later, I got curious at home and found the same emulator online. That led me to Project64, where I discovered I could play Super Smash Bros. 64 — a game I'd only played once as a kid and always wanted to play again.`,
  `Then I found the netplay tab. That's how I discovered Kaillera — and started playing SSB64 online with people from all over. I made a lot of friends through that community.`,
  `I always wanted to fix the problems with the emulator, the server, and the clients. But I was only 9 to 12 years old. Learning C++ and Java felt impossible. I got involved with the community efforts to improve things as best I could, eventually moved on, but never forgot about it.`,
  `Now, with the help of AI, I'm finally building what I always wanted Kaillera to be.`,
];

const COLLAPSED = '▶';
const EXPANDED = '▼';

/** The inline styles the two windows set. */
export interface SiteStyle {
  position: string;
  inset: string;
  background: string;
  display: string;
  alignItems: string;
  justifyContent: string;
  zIndex: string;
  padding: string;
  border: string;
  borderRadius: string;
  maxWidth: string;
  width: string;
  maxHeight: string;
  overflow: string;
  color: string;
  fontFamily: string;
  fontSize: string;
  fontStyle: string;
  margin: string;
  marginBottom: string;
  marginTop: string;
  cursor: string;
  borderBottom: string;
  borderTop: string;
  gap: string;
  textDecoration: string;
  lineHeight: string;
}

/** A click, as far as the windows read it. */
interface SiteClick {
  readonly target: object | null;
}

/** A key press, as far as the windows read it. */
interface SiteKey {
  readonly key: string;
}

/**
 * An element the windows are built from. `Self` is the page's own element
 * type, so what one element takes as a child is what the page creates.
 */
export interface SiteElement<Self> {
  id: string;
  textContent: string | null;
  innerHTML: string;
  readonly style: SiteStyle;
  readonly setAttribute: (name: string, value: string) => void;
  readonly addEventListener: (type: 'click', listener: (event: SiteClick) => void) => void;
  readonly append: (...children: Self[]) => void;
  readonly appendChild: (child: Self) => void;
  readonly remove: () => void;
}

/** A footer control already on the page: `#kn-version` or `#kn-about`. */
interface FooterControl {
  textContent: string | null;
  readonly addEventListener: (type: 'click', listener: () => void) => void;
}

/** The part of `window` the version display uses. */
export interface VersionHost<E extends SiteElement<E>> {
  readonly document: {
    readonly readyState: string;
    readonly body: { readonly appendChild: (child: E) => void };
    readonly createElement: (tag: string) => E;
    readonly getElementById: (id: string) => { readonly remove: () => void } | null;
    readonly querySelectorAll: (selector: string) => Iterable<FooterControl>;
    readonly addEventListener: {
      (type: 'keydown', listener: (event: SiteKey) => void): void;
      (type: 'DOMContentLoaded', listener: () => void): void;
    };
    readonly removeEventListener: (type: 'keydown', listener: (event: SiteKey) => void) => void;
  };
  readonly fetch: (url: string) => Promise<{ readonly json: () => Promise<StaticJson> }>;
}

/**
 * Start the version display on a page: wires `#kn-about`, then fills and
 * wires `#kn-version` once `/static/version.json` has answered. Waits for
 * the document when it is still loading.
 */
export const startVersion = <E extends SiteElement<E>>(host: VersionHost<E>): void => {
  const { document } = host;
  let changelog: readonly Release[] | null = null;
  let currentVersion: string | null = null;

  const element = (tag: string, styles: Partial<SiteStyle>, text?: string): E => {
    const created = document.createElement(tag);
    if (text !== undefined) created.textContent = text;
    Object.assign(created.style, styles);
    return created;
  };

  /** A window over the page: a dimmed backdrop, a card, and a header with a title and a close button. */
  const openWindow = (id: string, heading: E) => {
    document.getElementById(id)?.remove();
    const backdrop = element('div', {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '99999',
      padding: '20px',
    });
    backdrop.id = id;
    const card = element('div', {
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
    const header = element('div', {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px',
    });
    const close = element(
      'button',
      { background: 'none', border: 'none', color: '#888', fontSize: '24px', cursor: 'pointer', padding: '0 4px' },
      '×',
    );
    close.addEventListener('click', () => backdrop.remove());
    header.append(heading, close);
    card.appendChild(header);
    return { backdrop, card };
  };

  /** Put a built window on the page; a click on the backdrop or Escape closes it. */
  const show = (backdrop: E, card: E): void => {
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
    const onKey = (event: SiteKey): void => {
      if (event.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  };

  /** A header that shows and hides `body` when clicked; `arrow` points down while it shows. */
  const foldOnClick = (header: E, body: E, arrow: E): void => {
    header.addEventListener('click', () => {
      const visible = body.style.display !== 'none';
      body.style.display = visible ? 'none' : 'block';
      arrow.textContent = visible ? COLLAPSED : EXPANDED;
    });
  };

  const renderChangelog = (releases: readonly Release[]): void => {
    const { backdrop, card } = openWindow(
      'kn-changelog-modal',
      element('h2', { margin: '0', color: '#fff', fontSize: '18px' }, 'Changelog'),
    );
    releases.forEach((release, i) => {
      const section = element('div', { marginBottom: '12px' });
      const heading = element('div', {
        cursor: 'pointer',
        padding: '8px 0',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      });
      const label = element('span', {});
      label.innerHTML = releaseHeadingHtml(release);
      // Only the newest release starts open.
      const arrow = element('span', { color: '#666' }, i === 0 ? EXPANDED : COLLAPSED);
      heading.append(label, arrow);
      const list = element('ul', { margin: '8px 0 0 0', padding: '0 0 0 20px', display: i === 0 ? 'block' : 'none' });
      for (const change of release.changes) {
        const item = element('li', { marginBottom: '4px' });
        item.innerHTML = changeHtml(change);
        list.appendChild(item);
      }
      foldOnClick(heading, list, arrow);
      section.append(heading, list);
      card.appendChild(section);
    });
    show(backdrop, card);
  };

  const showChangelog = async (): Promise<void> => {
    if (!changelog) {
      try {
        const response = await host.fetch(`/static/changelog.json?_t=${Date.now()}`);
        changelog = decodeChangelog(await response.json());
      } catch {
        return;
      }
      if (!changelog) return;
    }
    renderChangelog(changelog);
  };

  const showAbout = (): void => {
    const { backdrop, card } = openWindow(
      'kn-about-modal',
      element('h2', { margin: '0', color: '#c9a227', fontSize: '20px' }, 'kaillera-next'),
    );

    const dedication = dedicationLine(currentVersion);
    if (dedication !== null) {
      card.appendChild(
        element('div', { color: '#c9a227', fontSize: '13px', marginBottom: '16px', fontStyle: 'italic' }, dedication),
      );
    }

    const lineage = element('div', { marginBottom: '16px' });
    for (const [project, author] of LINEAGE) {
      const row = element('div', { marginBottom: '4px' });
      row.innerHTML = lineageHtml(project, author);
      lineage.appendChild(row);
    }
    lineage.appendChild(
      element(
        'div',
        { color: '#666', fontStyle: 'italic', marginTop: '8px' },
        '...and the countless others who kept Kaillera alive',
      ),
    );
    card.appendChild(lineage);

    const links = element('div', { marginBottom: '16px', display: 'flex', gap: '16px' });
    for (const [label, url] of LINKS) {
      const link = element('a', {}, label);
      link.setAttribute('href', url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
      Object.assign(link.style, { color: '#c9a227', textDecoration: 'none', fontSize: '13px' });
      links.appendChild(link);
    }
    card.appendChild(links);

    const storyHeader = element('div', {
      cursor: 'pointer',
      padding: '8px 0',
      borderTop: '1px solid #333',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    });
    const storyArrow = element('span', { color: '#666' }, COLLAPSED);
    storyHeader.append(element('span', { color: '#fff' }, 'The Story'), storyArrow);
    const storyBody = element('div', { display: 'none' });
    for (const text of STORY_PARAGRAPHS) {
      storyBody.appendChild(element('p', { margin: '0 0 10px 0', lineHeight: '1.5', color: '#aaa' }, text));
    }
    foldOnClick(storyHeader, storyBody, storyArrow);
    card.append(storyHeader, storyBody);
    show(backdrop, card);
  };

  const start = async (): Promise<void> => {
    // About is wired first: it must open even when the version cannot be fetched.
    for (const control of document.querySelectorAll('#kn-about')) control.addEventListener('click', showAbout);
    try {
      const response = await host.fetch(`/static/version.json?_t=${Date.now()}`);
      const version = decodeVersionFile(await response.json());
      if (version === null) return;
      currentVersion = version;
      for (const control of document.querySelectorAll('#kn-version')) {
        control.textContent = `v${version}`;
        control.addEventListener('click', () => void showChangelog());
      }
    } catch {
      /* no version to show: the footer keeps what the page was served with */
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void start());
  else void start();
};
