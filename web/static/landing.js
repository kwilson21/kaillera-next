/**
 * landing.js — front page (docs/landing-design.md §7.2 M1).
 *
 * The open-rooms board (live / empty / waking / error), Create and the room
 * code field, the waking-state lag visualizer, the header mark set, and the
 * click-to-play video. No framework; every server string goes in as text.
 *
 * Consumed by: index.html
 * Exposes: nothing (self-contained IIFE)
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Same origin today. A static host in front (deploy/static/README.md) can
  // point the page at the game server with <meta name="kn-api" content="…">.
  const API = document.querySelector('meta[name="kn-api"]')?.content || '';
  const REDUCE = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const POLL_MS = 10000;
  const POLL_HIDDEN_MS = 30000;
  const IDLE_STOP_MS = 10 * 60 * 1000;
  const WAKE_POLL_MS = 3000;
  const WAKE_SLOW_MS = 120000;
  const STALE_FRAME_S = 30;

  const board = $('board');
  const STATES = ['loading', 'live', 'empty', 'waking', 'error'];
  let state = 'loading';

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const playUrl = (code, spectate) =>
    `${API}/play.html?room=${encodeURIComponent(code)}${spectate ? '&spectate=1' : ''}`;

  async function getJSON(path, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(API + path, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Board state ─────────────────────────────────────────────────────────

  function setState(next) {
    state = next;
    board.dataset.state = next;
    for (const s of STATES) $(`st-${s}`).hidden = s !== next;
    const waking = next === 'waking';
    const create = $('create-btn');
    create.disabled = waking;
    create.textContent = waking ? 'Create a room · ready in a moment' : 'Create a room';
    for (const id of ['join-btn', 'watch-btn', 'room-code']) $(id).disabled = waking;
  }

  function setText(node, text) {
    // Only touch the DOM on change, so aria-live announces real changes only.
    if (node.textContent !== text) node.textContent = text;
  }

  function renderHeader(people, matches, empty) {
    const live = $('board-live');
    if (empty) {
      live.classList.remove('live');
      live.dataset.text = '';
      setText(live, "nobody's in a room right now");
    } else if (people > 0) {
      live.classList.add('live');
      const text = `${plural(people, 'person', 'people')} playing right now`;
      if (live.dataset.text !== text) {
        live.dataset.text = text;
        live.textContent = '';
        live.append(el('span', 'dot'), text);
        live.firstChild.setAttribute('aria-hidden', 'true');
      }
    } else {
      live.dataset.text = '';
      setText(live, '');
    }
    // Real or absent (§7.2 M0.5): null until a full week has been counted.
    setText($('board-week'), matches == null ? '' : `${plural(matches, 'match', 'matches')} this week`);
  }

  function slotsEl(count, max) {
    const s = el('span', 'slots');
    s.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < max; i++) s.append(el('i', i < count ? `slot p${(i % 4) + 1} on` : 'slot'));
    return s;
  }

  function statusText(r) {
    if (r.status === 'playing') {
      if (!r.started_at) return 'in game';
      const min = Math.max(1, Math.floor((Date.now() / 1000 - r.started_at) / 60));
      return `in game · ${min} min`;
    }
    return r.player_count >= r.max_players ? 'full' : 'waiting for players';
  }

  function actionsEl(r, featured) {
    const acts = el('div', 'acts');
    const host = r.host_name || 'this player';
    const open = r.max_players - r.player_count;
    const watch = el('a', featured ? 'btn primary' : 'btn', 'Watch');
    watch.href = playUrl(r.room_code, true);
    watch.setAttribute('aria-label', `Watch ${host}'s room`);
    watch.dataset.act = 'watch';
    if (r.spectator_count < r.max_spectators) acts.append(watch);
    if (open > 0) {
      const label = featured ? `Join · ${plural(open, 'slot', 'slots')} open` : 'Join';
      const join = el('a', featured ? 'btn' : 'btn primary', label);
      join.href = playUrl(r.room_code, false);
      join.setAttribute('aria-label', `Join ${host}'s room, needs your ROM`);
      join.dataset.act = 'join';
      acts.append(join);
    }
    if (!acts.childElementCount) acts.append(el('span', 'st', 'Room full'));
    return acts;
  }

  // One <img> per frame box; a new frame fades in over the old one.
  function setFrame(box, r, lazy) {
    const url = r.frame_url && r.status === 'playing' ? API + r.frame_url : '';
    box.classList.toggle('live', !!url);
    box.classList.toggle('stale', !!url && r.frame_age_s > STALE_FRAME_S);
    const current = box.querySelector('img:last-of-type');
    if (!url) {
      box.querySelectorAll('img').forEach((i) => i.remove());
      box.setAttribute('aria-hidden', 'true');
      return;
    }
    box.removeAttribute('aria-hidden');
    if (current && current.dataset.src === url) return;
    if (document.hidden) return; // frames are fetched only while the tab is visible
    const img = el('img');
    img.alt = `Live frame from ${r.host_name || 'a player'}'s room`;
    img.dataset.src = url;
    img.decoding = 'async';
    if (lazy) img.loading = 'lazy';
    img.width = 320;
    img.height = 240;
    if (current && !REDUCE) {
      img.style.opacity = '0';
      img.addEventListener('load', () => {
        img.style.opacity = '';
        setTimeout(() => current.remove(), 650);
      });
      img.addEventListener('error', () => img.remove());
    } else if (current) {
      current.remove();
    }
    img.src = url;
    box.append(img);
  }

  const rowEls = new Map(); // room_code -> row element

  // Rebuilding a row replaces its links; if one had focus, give focus to the
  // same action in the new row (or the row's first link if it's gone).
  function keepFocus(container, rebuild) {
    const had = container.contains(document.activeElement) ? document.activeElement.dataset.act || '' : null;
    rebuild();
    if (had === null) return;
    const next = container.querySelector(`[data-act="${had}"]`) || container.querySelector('a, button');
    if (next) next.focus({ preventScroll: true });
  }

  // Rows rebuild only when what they show changes, so a poll never steals
  // keyboard focus; otherwise just the frame and the minutes update.
  const sigOf = (r) =>
    [r.status, r.player_count, r.max_players, r.spectator_count < r.max_spectators, r.host_name, r.game].join('|');

  function fillRow(row, r, index) {
    if (!row._thumb) row._thumb = el('div', 'thumb');
    setFrame(row._thumb, r, index > 1);
    const sig = sigOf(r);
    if (row.dataset.sig === sig) {
      setText(row.querySelector('.st'), statusText(r));
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
        row._thumb,
        el('div', 'g', r.game || 'Unknown game'),
        el('div', 'h', `hosted by ${r.host_name || 'a player'}`),
        sl,
        el('div', r.status === 'playing' ? 'st ingame' : 'st', statusText(r)),
        actionsEl(r, false),
      ),
    );
  }

  function renderFeatured(rooms) {
    const box = $('featured');
    const ingame = rooms.filter((r) => r.status === 'playing');
    const newest = (a, b) => (b.started_at || 0) - (a.started_at || 0);
    // Newest match with an open slot (joinable beats watchable), else the newest.
    const pick = ingame.filter((r) => r.player_count < r.max_players).sort(newest)[0] || ingame.sort(newest)[0];
    if (!pick) {
      box.hidden = true;
      box.dataset.code = '';
      return;
    }
    box.hidden = false;
    let screen = box.querySelector('.screen-box');
    if (box.dataset.code !== pick.room_code || !screen) {
      box.replaceChildren();
      screen = el('div', 'screen-box');
      box.append(screen, el('div', 'info'));
      box.dataset.code = pick.room_code;
    }
    setFrame(screen, pick, false);
    const info = box.querySelector('.info');
    const sig = sigOf(pick);
    if (info.dataset.sig === sig) {
      setText(info.querySelector('.st'), statusText(pick));
      return;
    }
    info.dataset.sig = sig;
    const meta = el('div', 'meta');
    meta.append(
      el('span', null, `hosted by ${pick.host_name || 'a player'}`),
      slotsEl(pick.player_count, pick.max_players),
      el('span', 'cnt', `${pick.player_count}/${pick.max_players}`),
      el('span', 'st ingame', statusText(pick)),
    );
    const open = pick.player_count < pick.max_players;
    keepFocus(info, () =>
      info.replaceChildren(
        el('div', 'kicker', 'Now playing'),
        el('h3', null, pick.game || 'Unknown game'),
        meta,
        actionsEl(pick, true),
        el(
          'p',
          'why',
          open
            ? 'Watch drops you in as a spectator. Join takes the open slot, mid-game, with your own ROM.'
            : 'Watch drops you in as a spectator. Join opens up when a slot does.',
        ),
      ),
    );
  }

  function render(rooms, stats) {
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
    const seen = new Set();
    rooms.forEach((r, i) => {
      seen.add(r.room_code);
      let row = rowEls.get(r.room_code);
      if (!row) {
        row = el('div', 'room');
        rowEls.set(r.room_code, row);
      }
      fillRow(row, r, i);
      // Move a row only when its position changes: moving a node drops focus.
      if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
    });
    for (const [code, row] of rowEls) {
      if (!seen.has(code)) {
        row.remove();
        rowEls.delete(code);
      }
    }
  }

  // ── Polling, waking ─────────────────────────────────────────────────────

  let pollTimer = 0;
  let pollCount = 0;
  let lastStats = null;
  const STATS_EVERY = 6;
  let lastInteraction = Date.now();
  let idleStopped = false;

  function schedule() {
    clearTimeout(pollTimer);
    if (Date.now() - lastInteraction > IDLE_STOP_MS) {
      idleStopped = true; // stop until the next interaction (§7.7)
      return;
    }
    pollTimer = setTimeout(refresh, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }

  function interacted() {
    lastInteraction = Date.now();
    if (idleStopped && state !== 'waking') {
      idleStopped = false;
      refresh();
    }
  }
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart']) {
    window.addEventListener(ev, interacted, { passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (state === 'live' || state === 'empty')) {
      lastInteraction = Date.now();
      idleStopped = false;
      refresh();
    }
  });

  async function refresh() {
    // The numbers change slowly: fetch them on the first poll and then about
    // once a minute, alongside the list. Optional; the list is not.
    const statsReq =
      pollCount++ % STATS_EVERY === 0
        ? getJSON('/api/stats/public', 8000)
            .then((st) => (lastStats = st))
            .catch(() => lastStats)
        : Promise.resolve(lastStats);
    let rooms;
    try {
      rooms = await getJSON('/list', 8000);
    } catch {
      // Health answered but the list didn't: say so, keep Create usable. A
      // failed poll under a board already on screen just keeps the board.
      if (state === 'loading' || state === 'waking') setState('error');
      schedule();
      return;
    }
    const stats = await statsReq; // null: the board still renders, the numbers stay absent
    render(
      rooms.filter((r) => r.room_code),
      stats,
    );
    schedule();
  }

  let wakeTimer = 0;
  let clockTimer = 0;

  function waking() {
    setState('waking');
    const started = Date.now();
    const clock = $('elapsed');
    clockTimer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (Date.now() - started > WAKE_SLOW_MS && !board.dataset.slow) {
        board.dataset.slow = '1';
        $('waking-line').textContent =
          "Still powering on. If this takes more than a couple of minutes, something's wrong on our side. Reload, or come back in a bit.";
      }
    }, 1000);
    const poll = async () => {
      try {
        await getJSON('/health', 2500);
      } catch {
        wakeTimer = setTimeout(poll, WAKE_POLL_MS);
        return;
      }
      clearInterval(clockTimer);
      refresh();
    };
    wakeTimer = setTimeout(poll, WAKE_POLL_MS);
  }

  async function start() {
    try {
      await getJSON('/health', 2000);
    } catch {
      waking();
      return;
    }
    refresh();
  }

  // ── Create, room code ───────────────────────────────────────────────────

  const codeInput = $('room-code');
  const randomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  };
  const getCode = () => {
    const val = codeInput.value.trim();
    const m = val.match(/room=([A-Za-z0-9]+)/);
    return (m ? m[1] : val).toUpperCase().replace(/[^A-Z0-9]/g, '');
  };
  const needCode = () => {
    codeInput.focus();
    codeInput.classList.remove('shake');
    void codeInput.offsetWidth;
    codeInput.classList.add('shake');
  };
  const go = (btn, url) => {
    btn.disabled = true;
    window.location.href = url;
  };

  $('create-btn').addEventListener('click', (e) =>
    go(e.currentTarget, `${API}/play.html?room=${randomCode()}&host=1&mode=rollback`),
  );
  $('join-btn').addEventListener('click', (e) => {
    const code = getCode();
    code ? go(e.currentTarget, playUrl(code, false)) : needCode();
  });
  $('watch-btn').addEventListener('click', (e) => {
    const code = getCode();
    code ? go(e.currentTarget, playUrl(code, true)) : needCode();
  });
  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });
  codeInput.addEventListener('animationend', () => codeInput.classList.remove('shake'));
  $('code-link').addEventListener('click', (e) => {
    $('code-box').classList.add('open');
    e.currentTarget.setAttribute('aria-expanded', 'true');
    e.currentTarget.hidden = true;
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
    const close = () => {
      o.remove();
      document.removeEventListener('keydown', close);
    };
    o.addEventListener('click', close);
    document.body.append(o);
    setTimeout(() => document.addEventListener('keydown', close), 100);
  });

  // ── Waking-state lag visualizer (same mechanics as /lag-test.html) ────────

  let lag = 120;
  let rollback = true;
  const verdict = () => {
    const v = $('verdict');
    const sub = $('verdict-sub');
    if (lag === 0) {
      v.textContent = 'No network lag';
      v.className = 'verdict ok';
      sub.textContent = 'Nothing to hide. Raise the slider.';
    } else if (rollback) {
      v.textContent = 'Round trip hidden';
      v.className = 'verdict ok';
      sub.textContent = `${lag} ms each way is still on the wire. Rollback predicts past it locally, so you don't wait.`;
    } else {
      v.textContent = `${lag * 2} ms wait per input`;
      v.className = 'verdict bad';
      sub.textContent = `Lockstep waits a full round trip on every input. ${lag} ms each way = ${lag * 2} ms before you see the response.`;
    }
  };
  const flash = (node, late) => {
    node.classList.remove('lit', 'late');
    void node.offsetHeight;
    if (late) node.classList.add('late');
    node.classList.add('lit');
  };
  const press = () => {
    const t0 = performance.now();
    flash($('p-in'), false);
    $('v-in').textContent = '0 ms';
    const wait = rollback ? 0 : lag * 2;
    if (!wait) {
      flash($('p-out'), false);
      $('v-out').textContent = '0 ms';
      return;
    }
    $('v-out').textContent = 'wait…';
    setTimeout(() => {
      flash($('p-out'), wait > 50);
      $('v-out').textContent = `+${Math.round(performance.now() - t0)} ms`;
    }, wait);
  };
  $('lag').addEventListener('input', (e) => {
    lag = Number(e.target.value) || 0;
    $('lag-out').textContent = `${lag} ms`;
    verdict();
  });
  $('rb').addEventListener('change', (e) => {
    rollback = e.target.checked;
    verdict();
  });
  const viz = $('viz');
  viz.addEventListener('click', (e) => {
    if (!e.target.closest('input, label')) press();
  });
  viz.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      press();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || state !== 'waking') return;
    if (e.target.closest('input, button, a, textarea, [role="button"]')) return;
    e.preventDefault();
    press();
  });
  verdict();

  // ── Header marks: one per visit, click to advance (§5.8) ─────────────────

  const MARKS = ['seats', 'ports', 'dpad', 'wheel', 'ko', 'stick', 'letters'];
  // Reduced motion freezes SMIL marks on a representative frame.
  const STILL_AT = { seats: 3.0, ports: 1.5 };

  function visitorSeed() {
    try {
      let v = localStorage.getItem('kn-visitor');
      if (!v) {
        v = Math.random().toString(36).slice(2, 10);
        localStorage.setItem('kn-visitor', v);
      }
      return v;
    } catch {
      return 'anon';
    }
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function initStick(svg) {
    const cap = svg.querySelector('.cap');
    const ring = svg.querySelector('.ring');
    const dots = svg.querySelectorAll('.cd');
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const sc = 32 / r.width;
      let dx = (e.clientX - r.left) * sc - 16;
      let dy = (e.clientY - r.top) * sc - 16;
      const d = Math.hypot(dx, dy);
      const m = Math.min(d, 8);
      if (d > 0) {
        dx = (dx / d) * m;
        dy = (dy / d) * m;
      }
      cap.style.transition = 'none';
      cap.style.transform = `translate(${dx}px,${dy}px)`;
      const dir = m > 5 ? (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'e' : 'w') : dy > 0 ? 's' : 'n') : '';
      dots.forEach((c) => c.setAttribute('stroke-opacity', c.dataset.dir === dir ? '1' : '0'));
    };
    const leave = () => {
      cap.style.transition = '';
      cap.style.transform = 'translate(0,0)';
      dots.forEach((c) => c.setAttribute('stroke-opacity', '0'));
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', leave);
    svg.addEventListener('pointerup', leave);
    svg.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // pressing the stick doesn't advance the mark
      move(e);
      ring.classList.remove('fire');
      void ring.getBoundingClientRect();
      ring.classList.add('fire');
    });
  }

  const hdr = $('hdr-mark');
  const tpl = $('marks');
  let markIdx = hash(`${Math.floor(Date.now() / 864e5)}:${visitorSeed()}`) % MARKS.length;

  function showMark(i) {
    const name = MARKS[i];
    hdr.replaceChildren();
    hdr.classList.toggle('wide', name === 'ko');
    const src = tpl.content.querySelector(`[data-mark="${name}"]`);
    if (!src) return; // "letters": the name alone
    const svg = src.cloneNode(true);
    svg.setAttribute('focusable', 'false');
    hdr.append(svg);
    if (name === 'stick') initStick(svg);
    if (REDUCE && svg.pauseAnimations) {
      svg.setCurrentTime(STILL_AT[name] || 0);
      svg.pauseAnimations();
    }
  }
  $('name').addEventListener('click', () => {
    markIdx = (markIdx + 1) % MARKS.length;
    if (REDUCE) {
      showMark(markIdx);
      return;
    }
    hdr.classList.add('fade');
    setTimeout(() => {
      showMark(markIdx);
      hdr.classList.remove('fade');
    }, 300);
  });
  showMark(markIdx);

  // ── Click-to-play video: poster first, the player only on click ──────────

  document.querySelectorAll('.lite').forEach((box) => {
    const id = box.dataset.video;
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id || '')) return;
    box.hidden = false;
    if (box.dataset.poster) box.style.backgroundImage = `url("${box.dataset.poster}")`;
    const btn = el('button', null, '▶');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Play video: ${box.dataset.title}, ${box.dataset.length}`);
    box.append(btn, el('span', 'cap', `${box.dataset.title} · ${box.dataset.length}`));
    btn.addEventListener('click', () => {
      const f = el('iframe');
      f.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&cc_load_policy=1`;
      f.title = box.dataset.title;
      f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      f.allowFullscreen = true;
      box.replaceChildren(f);
    });
  });
  const media = $('how-media');
  if (media.querySelector('.shots img, .lite:not([hidden])')) media.hidden = false;

  start();
})();
