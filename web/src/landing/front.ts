/**
 * The front page (docs/landing-design.md §7.2 M1). Moved from
 * web/static/landing.js.
 *
 * The open-rooms board (live / empty / waking / error), Create and the room
 * code field, the header mark set, and the click-to-play video. No framework;
 * every server string goes in as text. What the board decides is in
 * web/src/landing/board.ts.
 *
 * Ships in its own small bundle (web/src/landing-entry.ts →
 * web/static/dist/kn-landing.js): the page is served while the game server
 * sleeps, so it loads no core.
 */
import type { SafeStorage } from '../kn-state.ts';
import {
  BOARD_STATES,
  MARKS,
  asksForStats,
  codeFromInput,
  createText,
  featuredRoom,
  featuredWhy,
  frameUrl,
  isIdle,
  isStaleFrame,
  isVideoId,
  liveText,
  markIndexFor,
  newVisitor,
  nextMarkIndex,
  plural,
  pollDelay,
  refreshesOnReturn,
  roomActions,
  rowSignature,
  savedVisitor,
  stateAfterFailedList,
  statusText,
  stickPose,
  stillAt,
  weekText,
  type BoardState,
} from './board.ts';
import {
  FIRST_HEALTH_TIMEOUT_MS,
  FIRST_PING_TIMEOUT_MS,
  SLOW_WAKE_LINE,
  WAKE_POLL_MS,
  apiBase,
  elapsedText,
  hostUrl,
  isSlowWake,
  nextPingTimeout,
  playUrl,
  randomRoomCode,
  reportWakeDuration,
  sendDirectWake,
  slotClass,
  type CodeHost,
  type WakeHost,
} from './wake.ts';
import {
  boardRooms,
  getJSON,
  isHealthAnswer,
  isJson,
  isPublicStats,
  type BoardRoom,
  type Json,
  type PublicStats,
} from './wire.ts';

/** How long one request for the list or the numbers is given. */
const BOARD_TIMEOUT_MS = 8000;

/** The part of a page the front page uses. A browser `window` is one. */
export interface FrontHost extends WakeHost, CodeHost {
  readonly location: Location;
  readonly Math: Pick<Math, 'random'>;
  readonly Element: typeof Element;
  /** The safe storage wrapper, set by the small site bundle that loads first. */
  readonly KNStorage?: Pick<SafeStorage, 'get' | 'set'>;
  matchMedia(query: string): Pick<MediaQueryList, 'matches'>;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
  addEventListener(type: 'pageshow', listener: (event: PageTransitionEvent) => void): void;
  addEventListener(type: string, listener: () => void, options: AddEventListenerOptions): void;
}

/** The control that had focus before a render, so it can be given back after. */
interface FocusedAction {
  readonly node: Element;
  readonly code: string | undefined;
  readonly act: string;
  readonly index: number;
}

/** Run the front page on `host`. Called once, by the page's bundle. */
export const startFrontPage = (host: FrontHost): void => {
  const doc = host.document;
  const $ = <E extends HTMLElement = HTMLElement>(id: string): E => {
    const found = doc.querySelector<E>(`#${id}`);
    if (!found) throw new Error(`The front page has no #${id}`);
    return found;
  };
  const API = apiBase(doc);
  const REDUCE = host.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const board = $('board');
  let state: BoardState = 'loading';

  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string | null,
    text?: string | null,
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ── Board state ─────────────────────────────────────────────────────────

  const setState = (next: BoardState): void => {
    state = next;
    board.dataset.state = next;
    for (const s of BOARD_STATES) $(`st-${s}`).hidden = s !== next;
    const waking = next === 'waking';
    const create = $<HTMLButtonElement>('create-btn');
    create.disabled = waking;
    create.textContent = createText(next);
    for (const id of ['join-btn', 'watch-btn', 'room-code'])
      $<HTMLButtonElement | HTMLInputElement>(id).disabled = waking;
  };

  const setText = (node: Element | null, text: string): void => {
    // Only touch the DOM on change, so aria-live announces real changes only.
    if (node && node.textContent !== text) node.textContent = text;
  };

  const renderHeader = (people: number, matches: number | null | undefined, empty: boolean): void => {
    const live = $('board-live');
    const text = liveText(people, empty);
    if (people > 0) {
      live.classList.add('live');
      if (live.dataset.text !== text) {
        live.dataset.text = text;
        live.textContent = '';
        const dot = el('span', 'dot');
        live.append(dot, text);
        dot.setAttribute('aria-hidden', 'true');
      }
    } else {
      live.classList.remove('live');
      live.dataset.text = '';
      setText(live, text);
    }
    setText($('board-week'), weekText(matches));
  };

  const slotsEl = (count: number, max: number): HTMLElement => {
    const s = el('span', 'slots');
    s.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < max; i++) s.append(el('i', slotClass(i, count)));
    return s;
  };

  const actionsEl = (r: BoardRoom, featured: boolean): HTMLElement => {
    const acts = el('div', 'acts');
    for (const action of roomActions(r, featured)) {
      const link = el('a', action.primary ? 'btn primary' : 'btn', action.label);
      link.href = playUrl(API, r.room_code, action.spectate);
      link.setAttribute('aria-label', action.ariaLabel);
      link.dataset.act = action.act;
      acts.append(link);
    }
    if (!acts.childElementCount) acts.append(el('span', 'st', 'Room full'));
    return acts;
  };

  // One shown <img> per frame box, plus at most one loading behind it; a new
  // frame fades in over the old one. The LIVE badge shows only over a frame
  // that actually loaded.
  const setFrame = (box: HTMLElement, r: BoardRoom, lazy: boolean): void => {
    const url = frameUrl(API, r);
    const shown = (): HTMLImageElement | null => box.querySelector<HTMLImageElement>('img[data-loaded]');
    const mark = (): void => {
      const has = !!shown();
      box.classList.toggle('live', has);
      box.classList.toggle('stale', has && isStaleFrame(r));
      if (has) box.removeAttribute('aria-hidden');
      else box.setAttribute('aria-hidden', 'true');
    };
    if (!url) {
      box.querySelectorAll('img').forEach((i) => {
        i.remove();
      });
      mark();
      return;
    }
    const latest = box.querySelector<HTMLImageElement>('img:last-of-type');
    if (latest && latest.dataset.src === url) {
      mark();
      return;
    }
    // A frame still loading (off-screen lazy, slow link) is replaced, never stacked.
    box.querySelectorAll('img:not([data-loaded])').forEach((i) => {
      i.remove();
    });
    mark();
    if (doc.hidden) return; // frames are fetched only while the tab is visible
    const img = el('img');
    img.alt = `Live frame from ${r.host_name || 'a player'}'s room`;
    img.dataset.src = url;
    img.decoding = 'async';
    if (lazy) img.loading = 'lazy';
    img.width = 320;
    img.height = 240;
    const old = shown();
    if (old && !REDUCE) img.style.opacity = '0';
    img.addEventListener('load', () => {
      img.dataset.loaded = '';
      img.style.opacity = '';
      box.querySelectorAll('img[data-loaded]').forEach((i) => {
        if (i === img) return;
        if (REDUCE) i.remove();
        else host.setTimeout(() => i.remove(), 650);
      });
      mark();
    });
    img.addEventListener('error', () => {
      img.remove();
      mark();
    });
    img.src = url;
    box.append(img);
  };

  const rowEls = new Map<string, HTMLElement>(); // room_code -> row element
  const thumbs = new WeakMap<HTMLElement, HTMLElement>(); // row -> its frame box, kept across rebuilds

  // Rebuilding a row replaces its links; if one had focus, give focus to the
  // same action in the new row (or the row's first link if it's gone).
  const keepFocus = (container: HTMLElement, rebuild: () => void): void => {
    const had = container.contains(doc.activeElement) ? doc.activeElement?.getAttribute('data-act') || '' : null;
    rebuild();
    if (had === null) return;
    const next =
      container.querySelector<HTMLElement>(`[data-act="${had}"]`) || container.querySelector<HTMLElement>('a, button');
    if (next) next.focus({ preventScroll: true });
  };

  // Rows rebuild only when what they show changes, so a poll never steals
  // keyboard focus; otherwise just the frame and the minutes update.
  const fillRow = (row: HTMLElement, r: BoardRoom, index: number): void => {
    const thumb = thumbs.get(row) ?? el('div', 'thumb');
    thumbs.set(row, thumb);
    setFrame(thumb, r, index > 1);
    const sig = rowSignature(r);
    const status = statusText(r, host.Date.now());
    if (row.dataset.sig === sig) {
      setText(row.querySelector('.st'), status);
      return;
    }
    const becameLive = row.dataset.sig && row.dataset.status !== 'playing' && r.status === 'playing';
    row.dataset.sig = sig;
    row.dataset.status = r.status;
    const sl = el('div', 'sl');
    const slots = slotsEl(r.player_count, r.max_players);
    if (becameLive && !REDUCE) slots.classList.add('bounce'); // a room going live bounces once
    sl.append(slots, el('span', 'cnt', `${r.player_count}/${r.max_players}`));
    keepFocus(row, () =>
      row.replaceChildren(
        thumb,
        el('div', 'g', r.game || 'Unknown game'),
        el('div', 'h', `hosted by ${r.host_name || 'a player'}`),
        sl,
        el('div', r.status === 'playing' ? 'st ingame' : 'st', status),
        actionsEl(r, false),
      ),
    );
  };

  const renderFeatured = (rooms: readonly BoardRoom[]): void => {
    const box = $('featured');
    const pick = featuredRoom(rooms);
    if (!pick) {
      box.hidden = true;
      box.dataset.code = '';
      return;
    }
    box.hidden = false;
    let screen = box.querySelector<HTMLElement>('.screen-box');
    if (box.dataset.code !== pick.room_code || !screen) {
      box.replaceChildren();
      screen = el('div', 'screen-box');
      box.append(screen, el('div', 'info'));
      box.dataset.code = pick.room_code;
    }
    setFrame(screen, pick, false);
    const info = box.querySelector<HTMLElement>('.info');
    if (!info) return;
    const sig = rowSignature(pick);
    const status = statusText(pick, host.Date.now());
    if (info.dataset.sig === sig) {
      setText(info.querySelector('.st'), status);
      return;
    }
    info.dataset.sig = sig;
    const meta = el('div', 'meta');
    meta.append(
      el('span', null, `hosted by ${pick.host_name || 'a player'}`),
      slotsEl(pick.player_count, pick.max_players),
      el('span', 'cnt', `${pick.player_count}/${pick.max_players}`),
      el('span', 'st ingame', status),
    );
    keepFocus(info, () =>
      info.replaceChildren(
        el('div', 'kicker', 'Now playing'),
        el('h3', null, pick.game || 'Unknown game'),
        meta,
        actionsEl(pick, true),
        el('p', 'why', featuredWhy(pick)),
      ),
    );
  };

  // A poll can move or remove the node that has focus (a row reordered, the
  // featured room replaced). Put focus back on the same action for the same
  // room (its row when it's no longer featured), else the row now in its
  // place; never leave a keyboard user on <body>.
  const focusedAction = (): FocusedAction | null => {
    const a = doc.activeElement;
    const box = a?.closest<HTMLElement>('#featured, .room');
    if (!a || !box) return null;
    const row = a.closest('.room');
    return {
      node: a,
      code: box.dataset.code,
      act: a.getAttribute('data-act') || '',
      index: row?.parentNode ? Array.from(row.parentNode.children).indexOf(row) : 0,
    };
  };

  const restoreFocus = (f: FocusedAction | null): void => {
    if (!f || (f.node.isConnected && doc.activeElement === f.node)) return;
    if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement !== f.node) {
      return; // already placed (keepFocus inside a rebuilt row or panel)
    }
    const featured = $('featured');
    const rows = $('rooms').children;
    const box =
      (!featured.hidden && featured.dataset.code === f.code && featured) ||
      (f.code === undefined ? undefined : rowEls.get(f.code)) ||
      rows[Math.min(f.index, rows.length - 1)];
    const next =
      box && (box.querySelector<HTMLElement>(`[data-act="${f.act}"]`) || box.querySelector<HTMLElement>('a, button'));
    if (next) next.focus({ preventScroll: true });
  };

  const renderBoard = (rooms: readonly BoardRoom[], stats: PublicStats | null): void => {
    const people = stats?.people_playing_now ?? 0;
    const matches = stats ? stats.matches_this_week : null;
    if (!rooms.length) {
      renderHeader(people, matches, true);
      $('empty-week').replaceChildren();
      if (matches != null) {
        $('empty-week').append(el('b', null, plural(matches, 'match', 'matches')), ' were played this week. ');
      }
      if (state !== 'empty') setState('empty');
      return;
    }
    renderHeader(people, matches, false);
    if (state !== 'live') setState('live');
    renderFeatured(rooms);
    const list = $('rooms');
    // Gone rooms leave first, so the rows below them don't have to move.
    const seen = new Set(rooms.map((r) => r.room_code));
    for (const [code, row] of rowEls) {
      if (!seen.has(code)) {
        row.remove();
        rowEls.delete(code);
      }
    }
    rooms.forEach((r, i) => {
      let row = rowEls.get(r.room_code);
      if (!row) {
        row = el('div', 'room');
        row.dataset.code = r.room_code;
        rowEls.set(r.room_code, row);
      }
      fillRow(row, r, i);
      // Move a row only when its position changes: moving a node drops focus.
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    });
  };

  const render = (rooms: readonly BoardRoom[], stats: PublicStats | null): void => {
    const f = focusedAction();
    renderBoard(rooms, stats);
    restoreFocus(f);
  };

  // ── Polling, waking ─────────────────────────────────────────────────────

  let pollTimer = 0;
  let pollCount = 0;
  let lastStats: PublicStats | null = null;
  let refreshSeq = 0;
  let statsSeq = 0;
  let boardSeq = 0;
  let lastInteraction = host.Date.now();
  let idleStopped = false;

  const schedule = (): void => {
    host.clearTimeout(pollTimer);
    if (isIdle(host.Date.now(), lastInteraction)) {
      idleStopped = true; // stop until the next interaction (§7.7)
      return;
    }
    pollTimer = host.setTimeout(() => void refresh(false), pollDelay(doc.hidden));
  };

  const refresh = async (fresh: boolean): Promise<void> => {
    // The numbers change slowly: fetch them on the first poll, whenever
    // polling resumes (fresh), and then about once a minute. A failed fetch
    // drops the numbers and is retried on the next poll. Optional; the list
    // is not.
    // A refresh that resumes polling can overlap one still in flight. An
    // answer older than the one on screen is dropped; one that arrives first
    // is used, even if a newer refresh is still out.
    const seq = ++refreshSeq;
    if (fresh) pollCount = 0;
    const statsReq = asksForStats(pollCount++)
      ? getJSON(host, `${API}/api/stats/public`, BOARD_TIMEOUT_MS, isPublicStats)
          .then((st) => {
            if (seq < statsSeq) return;
            statsSeq = seq;
            lastStats = st;
          })
          .catch(() => {
            if (seq < statsSeq) return;
            statsSeq = seq;
            pollCount = 0; // retry on the next poll
            lastStats = null; // real or absent: never a stale count
          })
      : Promise.resolve();
    let list: Json;
    try {
      list = await getJSON(host, `${API}/list`, BOARD_TIMEOUT_MS, isJson);
    } catch {
      if (seq < boardSeq) return;
      const next = stateAfterFailedList(state);
      if (next !== state) setState(next);
      schedule();
      return;
    }
    await statsReq;
    if (seq < boardSeq) return; // a newer answer is already on screen
    boardSeq = seq;
    try {
      // null stats: the board still renders, the numbers stay absent
      render(boardRooms(list), lastStats);
    } finally {
      schedule(); // a render bug must not stop the board for good (cf. invariant I1)
    }
  };

  const interacted = (): void => {
    lastInteraction = host.Date.now();
    if (idleStopped && state !== 'waking') {
      idleStopped = false;
      void refresh(true);
    }
  };
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
    host.addEventListener(ev, interacted, { passive: true });
  }
  doc.addEventListener('visibilitychange', () => {
    if (refreshesOnReturn(doc.hidden, state)) {
      lastInteraction = host.Date.now();
      idleStopped = false;
      void refresh(true);
    }
  });

  let clockTimer = 0;

  const waking = (started: number): void => {
    setState('waking');
    const directWakeSent = sendDirectWake(host);
    const clock = $('elapsed');
    clockTimer = host.setInterval(() => {
      const elapsed = host.Date.now() - started;
      clock.textContent = elapsedText(elapsed);
      if (isSlowWake(elapsed) && !board.dataset.slow) {
        board.dataset.slow = '1';
        $('waking-line').textContent = SLOW_WAKE_LINE;
      }
    }, 1000);
    let timeout = FIRST_PING_TIMEOUT_MS;
    const poll = async (): Promise<void> => {
      try {
        await getJSON(host, `${API}/health`, timeout, isHealthAnswer);
      } catch {
        timeout = nextPingTimeout(timeout);
        host.setTimeout(() => void poll(), WAKE_POLL_MS);
        return;
      }
      host.clearInterval(clockTimer);
      reportWakeDuration(host, API, 'front', started, directWakeSent);
      void refresh(false);
    };
    host.setTimeout(() => void poll(), WAKE_POLL_MS);
  };

  const start = async (): Promise<void> => {
    const started = host.Date.now();
    try {
      await getJSON(host, `${API}/health`, FIRST_HEALTH_TIMEOUT_MS, isHealthAnswer);
    } catch {
      waking(started);
      return;
    }
    void refresh(false);
  };

  // ── Create, room code ───────────────────────────────────────────────────

  const codeInput = $<HTMLInputElement>('room-code');
  const needCode = (): void => {
    codeInput.focus();
    codeInput.classList.remove('shake');
    void codeInput.offsetWidth;
    codeInput.classList.add('shake');
  };
  const go = (btn: HTMLButtonElement, url: string): void => {
    btn.disabled = true;
    host.location.href = url;
  };

  // Back from the room page (bfcache): the button we disabled on the way
  // out comes back disabled; give the page its current state again.
  host.addEventListener('pageshow', (e) => {
    if (e.persisted) setState(state);
  });

  const createBtn = $<HTMLButtonElement>('create-btn');
  createBtn.addEventListener('click', () => go(createBtn, hostUrl(API, randomRoomCode(host))));
  const joinBtn = $<HTMLButtonElement>('join-btn');
  joinBtn.addEventListener('click', () => {
    const code = codeFromInput(codeInput.value);
    if (code) go(joinBtn, playUrl(API, code, false));
    else needCode();
  });
  const watchBtn = $<HTMLButtonElement>('watch-btn');
  watchBtn.addEventListener('click', () => {
    const code = codeFromInput(codeInput.value);
    if (code) go(watchBtn, playUrl(API, code, true));
    else needCode();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
  codeInput.addEventListener('animationend', () => codeInput.classList.remove('shake'));
  const codeLink = $('code-link');
  codeLink.addEventListener('click', () => {
    $('code-box').classList.add('open');
    codeLink.setAttribute('aria-expanded', 'true');
    codeLink.hidden = true;
    codeInput.focus();
  });

  // Kaillera handshake homage: type HELLO in the code field.
  codeInput.addEventListener('input', () => {
    if (codeInput.value.toUpperCase() !== 'HELLO') return;
    codeInput.value = '';
    const o = el('div');
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-label', 'HELLOD00D');
    Object.assign(o.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,.95)',
      color: '#0f8',
      display: 'grid',
      placeContent: 'center',
      textAlign: 'center',
      font: "14px/2 'Courier New', monospace",
      zIndex: '99999',
      cursor: 'pointer',
    });
    const hero = el('div', null, 'HELLOD00D');
    hero.style.cssText = 'font-size:48px;font-weight:bold;letter-spacing:4px;margin-bottom:12px';
    o.append(
      hero,
      el('div', null, 'Server Connection Response — port: 27888'),
      el('div', null, 'Kaillera (2001) by Christophe Thibault'),
      el('div', null, 'kaillera-next — continuing the legacy · v0.9 forever'),
    );
    const close = (): void => {
      o.remove();
      doc.removeEventListener('keydown', close);
    };
    o.addEventListener('click', close);
    doc.body.append(o);
    host.setTimeout(() => doc.addEventListener('keydown', close), 100);
  });

  // ── Header marks: one per visit, click to advance (§5.8) ─────────────────

  const visitorSeed = (): string => {
    const S = host.KNStorage;
    try {
      if (!S) return 'anon';
      const saved = savedVisitor(S.get('localStorage', 'kn-visitor'));
      if (saved) return saved;
      const v = newVisitor(host.Math.random());
      S.set('localStorage', 'kn-visitor', v);
      return v;
    } catch {
      return 'anon'; // a blocked or full store
    }
  };

  const initStick = (svg: SVGSVGElement): void => {
    const cap = svg.querySelector<SVGElement>('.cap');
    const ring = svg.querySelector<SVGElement>('.ring');
    const dots = svg.querySelectorAll<SVGElement>('.cd');
    if (!cap || !ring) return;
    const move = (e: PointerEvent): void => {
      const r = svg.getBoundingClientRect();
      const sc = 32 / r.width;
      const pose = stickPose((e.clientX - r.left) * sc, (e.clientY - r.top) * sc);
      cap.style.transition = 'none';
      cap.style.transform = `translate(${pose.dx}px,${pose.dy}px)`;
      dots.forEach((c) => {
        c.setAttribute('stroke-opacity', c.dataset.dir === pose.dir ? '1' : '0');
      });
    };
    const leave = (): void => {
      cap.style.transition = '';
      cap.style.transform = 'translate(0,0)';
      dots.forEach((c) => {
        c.setAttribute('stroke-opacity', '0');
      });
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', leave);
    svg.addEventListener('pointerup', leave);
    svg.addEventListener('pointerdown', (e) => {
      move(e);
      ring.classList.remove('fire');
      void ring.getBoundingClientRect();
      ring.classList.add('fire');
    });
  };

  const hdr = $('hdr-mark');
  const tpl = $<HTMLTemplateElement>('marks');
  let markIdx = markIndexFor(host.Date.now(), visitorSeed());

  const showMark = (i: number): void => {
    const name = MARKS[i] ?? 'letters';
    hdr.replaceChildren();
    hdr.classList.toggle('wide', name === 'ko');
    const src = tpl.content.querySelector<SVGSVGElement>(`[data-mark="${name}"]`);
    if (!src) return; // "letters": the name alone
    // SAFETY: a deep clone of an <svg> element is an <svg> element.
    const svg = src.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('focusable', 'false');
    hdr.append(svg);
    if (name === 'stick') initStick(svg);
    if (REDUCE && typeof svg.pauseAnimations === 'function') {
      svg.setCurrentTime(stillAt(name));
      svg.pauseAnimations();
    }
  };
  $('name').addEventListener('click', (e) => {
    if (e.target instanceof host.Element && e.target.closest('[data-mark="stick"]')) return; // pressing the stick plays with it
    markIdx = nextMarkIndex(markIdx);
    if (REDUCE) {
      showMark(markIdx);
      return;
    }
    hdr.classList.add('fade');
    host.setTimeout(() => {
      showMark(markIdx);
      hdr.classList.remove('fade');
    }, 300);
  });
  showMark(markIdx);

  // Captures are enabled by adding metadata only; absent entries create no
  // requests or empty placeholders. Dimensions reserve space before lazy load.
  const SHOTS = [
    {
      src: '/static/shots/s1-room.webp',
      w: 1056,
      h: 1856,
      alt: 'The room page: room code KAZ64, "Play link copied!", Kaz and Agent 21 both with the ROM loaded, Start Game ready.',
    },
    {
      src: '/static/shots/s2-invite.webp',
      w: 1170,
      h: 1700,
      alt: 'The invite link on a phone: "Kaz invited you to play Super Smash Bros. 64", 1 of 4 in the room, Join the room or Watch instead.',
    },
    {
      src: '/static/shots/s3-match.webp',
      w: 1651,
      h: 498,
      alt: 'The same moment of one match on a laptop and on a phone with on-screen controls: Mario at the ledge, Donkey Kong mid-stage, both at 0%.',
    },
  ];
  const shots = $('shots');
  for (const shot of SHOTS) {
    if (!shot.src || !shot.w || !shot.h || !shot.alt) continue;
    const img = el('img');
    img.src = shot.src;
    img.width = shot.w;
    img.height = shot.h;
    img.alt = shot.alt;
    if (shot.w > shot.h * 2) img.classList.add('wide');
    img.loading = 'lazy';
    img.decoding = 'async';
    shots.append(img);
  }

  // ── Click-to-play video: poster first, the player only on click ──────────

  doc.querySelectorAll<HTMLElement>('.lite').forEach((box) => {
    const id = box.dataset.video;
    if (!isVideoId(id)) return;
    box.hidden = false;
    if (box.dataset.poster) box.style.backgroundImage = `url("${box.dataset.poster}")`;
    const btn = el('button', null, '▶');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Play video: ${box.dataset.title}, ${box.dataset.length}`);
    box.append(btn, el('span', 'cap', `${box.dataset.title} · ${box.dataset.length}`));
    btn.addEventListener('click', () => {
      const f = el('iframe');
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&cc_load_policy=1`;
      f.title = String(box.dataset.title);
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      box.replaceChildren(f);
    });
  });
  const media = $('how-media');
  if (media.querySelector('.shots img, .lite:not([hidden])')) media.hidden = false;

  void start();
};
