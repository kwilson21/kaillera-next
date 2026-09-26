/**
 * join.js — the invite page (docs/landing-design.md §7.2 M2, W3).
 *
 * /join?room=CODE[&spectate=1] looks the room up, wakes the server if it's
 * napping, and says who invited you, what Join needs and what Watch doesn't
 * before handing off to /play.html. States: waiting · full · closed ·
 * in-app browser · waking · spectator link · unsupported browser.
 *
 * Consumed by: join.html
 * Exposes: nothing (self-contained IIFE)
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const API = document.querySelector('meta[name="kn-api"]')?.content || '';
  const WAKE_POLL_MS = 3000;
  const WAKE_SLOW_MS = 120000;
  const REFRESH_MS = 15000;
  const GAMES = {
    ssb64: { name: 'Super Smash Bros. 64', rom: 'SSB64' },
    'smash-remix': { name: 'Smash Remix', rom: 'Smash Remix' },
  };
  // The common in-app browsers that open links from chats (§7.2 M2).
  const IN_APP = [
    [/Discord/i, 'Discord'],
    [/Instagram/i, 'Instagram'],
    [/FB_IAB|FBAN|FBAV|Messenger/i, 'Facebook'],
    [/musical_ly|TikTok|BytedanceWebview/i, 'TikTok'],
    [/Twitter/i, 'X'],
  ];

  const params = new URLSearchParams(location.search);
  const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const spectate = params.get('spectate') === '1';
  const playUrl = (watch) => `${API}/play.html?room=${encodeURIComponent(code)}${watch ? '&spectate=1' : ''}`;

  const SECTIONS = ['inv-loading', 'inv-main', 'inv-closed', 'inv-unsupported', 'inv-waking'];
  let state = 'loading';
  function show(id) {
    state = id;
    for (const s of SECTIONS) $(s).hidden = s !== id;
  }

  async function getJSON(path, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(API + path, { signal: ctl.signal, cache: 'no-store' });
      if (res.status === 404) return null; // the room isn't there
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Copy link (in-app banner, unsupported browser) ────────────────────────

  async function copyLink(btn) {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch {
        /* nothing more to try; the link is in the address bar */
      }
      ta.remove();
    }
    btn.textContent = 'Copied';
    setTimeout(() => (btn.textContent = 'Copy link'), 2000);
  }
  $('inapp-copy').addEventListener('click', (e) => copyLink(e.currentTarget));
  $('unsup-copy').addEventListener('click', (e) => copyLink(e.currentTarget));

  const inApp = IN_APP.find(([re]) => re.test(navigator.userAgent));
  if (inApp) {
    $('inapp-text').textContent =
      `You're in ${inApp[1]}'s built-in browser. Open this link in Safari or Chrome for the game to run.`;
    $('inapp').hidden = false;
  }
  const hasWebRTC = typeof window.RTCPeerConnection === 'function';
  const canPlay = hasWebRTC && typeof window.WebAssembly === 'object';

  // ── Room states ────────────────────────────────────────────────────────

  function randomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => chars[b % chars.length]).join('');
  }
  $('open-own').addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    location.href = `${API}/play.html?room=${randomCode()}&host=1&mode=rollback`;
  });

  function showClosed(host) {
    const h = (host || '').trim();
    $('closed-title').textContent = h ? `${h}'s room has closed.` : 'This room has closed.';
    $('closed-line').textContent = h
      ? `Rooms live only while someone's in them. Ask ${h} for a new link, or open your own.`
      : "Rooms live only while someone's in them. Ask for a new link, or open your own.";
    document.title = 'Room closed · kaillera-next';
    show('inv-closed');
  }

  let slotsShown = false;
  function factsEl(room) {
    const frag = document.createDocumentFragment();
    const slots = document.createElement('span');
    slots.className = slotsShown ? 'slots' : 'slots fill-in'; // markers fill in once, as the lookup answers
    slots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < room.max_players; i++) {
      const s = document.createElement('i');
      s.className = i < room.player_count ? `slot p${(i % 4) + 1} on` : 'slot';
      s.style.setProperty('--n', i);
      slots.append(s);
    }
    slotsShown = true;
    const status =
      room.status === 'playing' ? 'in game' : room.player_count >= room.max_players ? 'full' : 'waiting for players';
    frag.append(slots, ` ${room.player_count} of ${room.max_players} in the room · ${status}`);
    return frag;
  }

  function showRoom(room) {
    const game = GAMES[room.game_id] || { name: room.romName || 'Super Smash Bros. 64', rom: 'SSB64' };
    const host = (room.host_name || '').trim();
    const full = room.player_count >= room.max_players;
    const watchFirst = spectate || full;

    $('inv-kicker').textContent = spectate
      ? host
        ? `Watch ${host}'s room`
        : 'Watch this room'
      : host
        ? `${host} invited you to play`
        : "You're invited to play";
    $('inv-title').textContent = game.name;
    document.title = `${$('inv-kicker').textContent} · kaillera-next`;
    $('inv-facts').replaceChildren(factsEl(room));
    $('inv-fullline').hidden = !full || spectate;

    const join = $('inv-join');
    const watch = $('inv-watch');
    join.href = playUrl(false);
    watch.href = playUrl(true);
    join.textContent = full
      ? 'Join when a slot opens'
      : spectate
        ? 'Join if a slot opens · needs your ROM'
        : 'Join the room';
    watch.textContent = watchFirst ? 'Watch' : 'Watch instead';
    join.className = watchFirst ? 'btn big' : 'btn primary big';
    watch.className = watchFirst ? 'btn primary big' : 'btn big';
    $('inv-join-hint').textContent = spectate
      ? `needs your own ${game.rom} ROM`
      : `needs your own ${game.rom} ROM (.z64 / .n64 / .v64 / .zip)`;
    // Primary first: Watch leads for a full room or a spectator link.
    const stack = $('inv-stack');
    const joinPair = [join, $('inv-join-hint')];
    const watchPair = [watch, $('inv-watch-hint')];
    stack.replaceChildren(...(watchFirst ? [...watchPair, ...joinPair] : [...joinPair, ...watchPair]));
    // No WebRTC: nothing on the room page can work, not even watching.
    join.hidden = $('inv-join-hint').hidden = !canPlay;
    watch.hidden = $('inv-watch-hint').hidden = !hasWebRTC;

    $('inv-next').textContent = spectate
      ? "What happens next: you'll see the game as it plays, with sound. If a slot opens, you can take it with your own ROM."
      : room.status === 'playing'
        ? `What happens next: pick a name and drop your ROM; you join ${host ? `${host}'s` : 'the'} match in progress.`
        : `What happens next: pick a name, drop your ROM, wait for ${host || 'the host'} to press Start.`;
    if (state !== 'inv-main') show('inv-main');
  }

  let refreshTimer = 0;
  async function lookup() {
    clearTimeout(refreshTimer);
    let room;
    try {
      room = await getJSON(`/room/${encodeURIComponent(code)}`, 8000);
    } catch {
      // The server answered /health but not this; try again shortly.
      refreshTimer = setTimeout(lookup, WAKE_POLL_MS);
      return;
    }
    if (!room) return showClosed('');
    // A room nobody is connected to takes back only its own members (§7.2 M0.2).
    if (room.closed) return showClosed(room.host_name);
    showRoom(room);
    refreshTimer = setTimeout(lookup, REFRESH_MS);
  }

  // ── Waking ─────────────────────────────────────────────────────────────

  function waking() {
    show('inv-waking');
    const started = Date.now();
    const clock = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $('elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (Date.now() - started > WAKE_SLOW_MS) {
        $('waking-line').textContent =
          "Still powering on. If this takes more than a couple of minutes, something's wrong on our side. Reload, or come back in a bit.";
      }
    }, 1000);
    // A slow link may need longer than a napping server does: each miss
    // gives the next ping more time, up to 10 s.
    let timeout = 2500;
    const poll = async () => {
      try {
        await getJSON('/health', timeout);
      } catch {
        timeout = Math.min(timeout * 2, 10000);
        setTimeout(poll, WAKE_POLL_MS);
        return;
      }
      clearInterval(clock);
      lookup();
    };
    setTimeout(poll, WAKE_POLL_MS);
  }

  window.KNLagViz.init(() => state === 'inv-waking');

  async function start() {
    if (!code) return showClosed('');
    if (!canPlay && !hasWebRTC) return show('inv-unsupported');
    try {
      await getJSON('/health', 2000);
    } catch {
      waking();
      return;
    }
    lookup();
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state === 'inv-main') lookup();
  });

  start();
})();
