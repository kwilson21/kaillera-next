/**
 * Landing Worker (hosting option A, deploy/static/README.md).
 *
 * One domain, two hosts behind it:
 *   - the front page (/) and the invite page (/join) come from this Worker's
 *     static assets, so they load instantly even while the game server naps;
 *   - everything else (the game page, the API, Socket.IO) is passed through
 *     to the game server at env.ORIGIN, WebSocket upgrades included.
 *
 * Link previews: chat apps fetch /join to build a card. For their crawlers
 * the Worker asks the game server for the room's preview tags (1.5 s budget)
 * and falls back to the static page's generic tags.
 *
 * Staleness: if a Render release ships a new / or /join (or a file they
 * load) and nobody redeploys this Worker, its assets would otherwise keep
 * serving the old copies forever. Each isolate keeps a cached freshness
 * verdict and refreshes it in the background (see `refreshFreshness`); while
 * it reads 'stale', pages and their files are proxied to the origin instead
 * of served from assets, with a short timeout and a fallback back to this
 * Worker's own copy so a napping origin never costs a visitor a blank tab
 * (see `proxyLanding`). See the README's "First-request edge" note for the one
 * case (a brand-new isolate, first request, verdict still 'unknown') this
 * doesn't fully cover.
 *
 * Build: python scripts/build_landing.py   Deploy: npx wrangler deploy -c wrangler.landing.jsonc
 */

// Every file the two pages load. Serving all of them here matters: the
// pages' scripts are `defer`, so one proxied script behind a napping server
// would hold up the waking screen itself.
//
// version.json and changelog.json are packaged for instant footer fallback,
// but deliberately excluded from the landing build id because CI rewrites
// them on nearly every merge (server/src/landing_build.py has the reason).
const PAGES = { '/': '/index.html', '/index.html': '/index.html', '/join': '/join.html' };
const ASSET_PREFIXES = ['/static/fonts/', '/static/shots/'];
const ASSET_FILES = new Set([
  '/static/landing.css',
  '/static/landing.js',
  '/static/lagviz.js',
  '/static/join.js',
  '/static/storage.js',
  '/static/version.js',
  '/static/version-guard.js',
  '/static/feedback.js',
  '/static/version.json',
  '/static/changelog.json',
  '/static/favicon.svg',
  '/static/kn-logo.svg',
  '/static/apple-touch-icon.png',
  '/static/og/home.png', // the generic link-preview image: crawlers fetch it while the server naps
  '/static/landing-build.json', // this build's id — see refreshFreshness()
]);

// The same policy the game server sends for / and /join (server/src/api/app.py).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "connect-src 'self'; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'self'; frame-src https://www.youtube-nocookie.com";

const CRAWLER =
  /Discordbot|Twitterbot|facebookexternalhit|Facebot|Slackbot|WhatsApp|TelegramBot|LinkedInBot|SkypeUriPreview|Applebot|redditbot|Embedly|Iframely/i;
const PREVIEW_TIMEOUT_MS = 1500;

function withHeaders(res, isPage) {
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  if (isPage) {
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Frame-Options', 'SAMEORIGIN');
    out.headers.set('Cache-Control', 'no-store');
  } else {
    out.headers.set('Cache-Control', 'no-cache'); // revalidate: same files the game server would send
  }
  return out;
}

// The static pages carry generic preview tags with a host placeholder. On
// /join the canonical link keeps the invite (only a room ID that fits the
// server's pattern goes in; anything else is left out).
async function staticPage(res, url) {
  let html = (await res.text()).replaceAll('https://__KN_HOST__', `https://${url.host}`);
  const raw = url.searchParams.get('room') || '';
  const room = /^[A-Za-z0-9]{3,16}$/.test(raw) ? raw : ''; // case-sensitive, like the server
  if (url.pathname === '/join' && room) {
    const spectate = url.searchParams.get('spectate') === '1' ? '&amp;spectate=1' : '';
    html = html.replace(
      `property="og:url" content="https://${url.host}/join"`,
      `property="og:url" content="https://${url.host}/join?room=${room}${spectate}"`,
    );
  }
  return withHeaders(new Response(html, res), true);
}

async function previewPage(request, env, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(new URL(url.pathname + url.search, env.ORIGIN), {
      headers: forwardedHeaders(
        request,
        env,
        new Headers({ 'User-Agent': request.headers.get('User-Agent') || '', Accept: 'text/html' }),
      ),
      signal: ctl.signal,
    });
    if (res.status < 500) originSucceeded();
    if (res.ok) {
      // The game server builds absolute URLs from the host it was asked on
      // (the origin's); point them at the public host so the card and the
      // link go through this Worker.
      const html = (await res.text()).replaceAll(`https://${new URL(env.ORIGIN).host}`, `https://${url.host}`);
      return withHeaders(new Response(html, res), true);
    }
  } catch {
    /* napping or slow: the static page's generic card is fine */
  } finally {
    clearTimeout(timer);
  }
  return null;
}

// Cloudflare sets CF-Connecting-IP on this Worker's subrequests to the
// Worker's own address, so the game server would see every visitor as one IP
// (one connection limit, one rate limit). Pass the visitor's IP along with a
// shared secret the server checks (KN_PROXY_SECRET there, PROXY_SECRET here).
// Logged once per isolate (not per request) so a busy Worker without
// PROXY_SECRET doesn't flood the tail log; never logs header values.
let _warnedNoProxySecret = false;

function forwardedHeaders(request, env, headers) {
  // Strip any spelling of these a visitor could send (headers are
  // case-insensitive, and engineio folds '-'/'_' together server-side), so
  // only this Worker's own values below ever reach the origin.
  const toDelete = [];
  for (const name of headers.keys()) {
    const norm = name.toLowerCase().replace(/_/g, '-');
    if (norm === 'x-kn-client-ip' || norm === 'x-kn-proxy-auth') toDelete.push(name);
  }
  for (const name of toDelete) headers.delete(name);
  if (!env.PROXY_SECRET && !_warnedNoProxySecret) {
    _warnedNoProxySecret = true;
    console.error(
      "PROXY_SECRET is not set — every visitor will reach the origin as this Worker's own address " +
        '(one connection limit and one rate limit for the whole site)',
    );
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (env.PROXY_SECRET && ip) {
    headers.set('X-KN-Client-IP', ip);
    headers.set('X-KN-Proxy-Auth', env.PROXY_SECRET);
  }
  return headers;
}

// The game server builds absolute OG URLs (and everything else) from the
// Host header it was asked on, which through a proxied request is the
// origin's own hostname — a shared /play.html link would otherwise preview
// with kaillera-next.onrender.com. Rewrite it to the public host for any
// HTML response, the same way previewPage() does for /join. Left untouched:
// non-HTML bodies (JS/JSON/images — nothing in them names the origin host),
// a HEAD request (no body was sent to read or rewrite), and WebSocket
// upgrades (status 101, no body either).
//
// This reads the whole body with res.text() — there's no server HTML
// response that streams today, so nothing here passes a streaming response
// through untouched; if one ever did, this would buffer it too.
//
// If the origin's HTML is gzip-compressed, the Workers runtime already
// decoded it before res.text() sees it, and re-encodes the rewritten text on
// the way out because the Content-Encoding header is carried over into
// `out` below — so the client still gets a body matching the encoding it
// declared. Don't strip Content-Encoding here; that's what makes the
// rewrite correct rather than accidentally serving mislabeled bytes.
async function rewriteOriginHost(res, env, url, method) {
  if (res.status === 101 || method === 'HEAD') return res;
  const contentType = res.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('text/html')) return res;
  const originHost = new URL(env.ORIGIN).host;
  const html = (await res.text()).replaceAll(`https://${originHost}`, `https://${url.host}`);
  const out = new Response(html, res);
  out.headers.delete('Content-Length'); // length changed (and may not have been set at all)
  return out;
}

async function proxy(request, env, url) {
  const target = new URL(url.pathname + url.search, env.ORIGIN);
  const req = new Request(target, request);
  forwardedHeaders(request, env, req.headers);
  const res = await fetch(req);
  if (res.status < 500) originSucceeded();
  return rewriteOriginHost(res, env, url, request.method);
}

// Same as proxy(), but only ever used for a page or a landing asset while
// the freshness verdict reads 'stale' — never for the API, Socket.IO,
// WebSocket upgrades or /play.html (those always use plain proxy() above,
// with no timeout). A stale origin is worth waiting on briefly, but a
// visitor should never sit on a blank tab because it's napping: on a
// timeout or any error this returns null so the caller falls back to this
// Worker's own (possibly outdated, but instant) copy instead.
const STALE_PROXY_TIMEOUT_MS = 3000;
const METADATA_PROXY_TIMEOUT_MS = 800;
const ORIGIN_SLOW_COOLDOWN_MS = 30_000;
let _originSlowUntil = 0;
let _metadataSlowUntil = 0;

function originSucceeded() {
  _originSlowUntil = 0;
  _metadataSlowUntil = 0;
}

async function proxyLanding(request, env, url, timeoutMs = STALE_PROXY_TIMEOUT_MS, isMetadata = false) {
  if (Date.now() < _originSlowUntil) return null;
  if (isMetadata && Date.now() < _metadataSlowUntil) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const target = new URL(url.pathname + url.search, env.ORIGIN);
    const req = new Request(target, request);
    forwardedHeaders(request, env, req.headers);
    const res = await fetch(req, { signal: ctl.signal });
    if (res.status < 500) originSucceeded();
    if (!res.ok && res.status !== 304) return null;
    return await rewriteOriginHost(res, env, url, request.method);
  } catch {
    if (isMetadata) {
      _metadataSlowUntil = Date.now() + ORIGIN_SLOW_COOLDOWN_MS;
    } else {
      _originSlowUntil = Date.now() + ORIGIN_SLOW_COOLDOWN_MS;
    }
    return null; // timed out or errored: caller falls back to our own copy
  } finally {
    clearTimeout(timer);
  }
}

// ── Freshness: does this Worker's own build match what the origin is
// serving right now? ──────────────────────────────────────────────────────
//
// `scripts/build_landing.py` writes this Worker's own landing build id into
// its assets (static/landing-build.json); the game server computes the same
// id from its own web/ directory and answers it at GET /api/landing-build
// (server/src/api/app.py, server/src/landing_build.py — one function, so
// the two sides can't disagree about what the id covers). When they match,
// this Worker's cached pages are exactly what the origin would serve.
//
// The verdict is cached per isolate. `checkedAt` is stamped the moment a
// check STARTS (not when it finishes), and only one check runs at a time
// per isolate (`_inFlight`): a burst of concurrent requests schedules at
// most one `refreshFreshness` call. It runs in the background via
// ctx.waitUntil so it never delays the response in front of it, except that
// a PAGE request (never an asset request) made while the verdict is still
// 'unknown' waits for the very first in-flight check, capped at
// UNKNOWN_CHECK_WAIT_MS — see `currentVerdict`.
//
// `known` only ever changes on a *conclusive* result (a definite match or
// mismatch of two non-empty ids). A timeout, network error, non-2xx
// response, unparseable body, or an empty/non-string id is inconclusive:
// the previous verdict is left exactly alone, and the next attempt is
// naturally backed off by FRESHNESS_TTL_MS, because `checkedAt` was already
// advanced to when this (failed) check started — the origin merely napping
// must never be read as "stale" (that would flip a healthy Worker into
// proxying everything to a server that isn't answering yet), and it must
// never be hammered on every request either.
const FRESHNESS_TTL_MS = 60_000;
const FRESHNESS_CHECK_TIMEOUT_MS = 1500;
const UNKNOWN_CHECK_WAIT_MS = 300;

let _freshness = { known: 'unknown', checkedAt: 0 };
let _inFlight = null;

let _ownBuildIdPromise = null;

async function ownBuildId(env) {
  if (!_ownBuildIdPromise) {
    _ownBuildIdPromise = env.ASSETS.fetch(new Request('https://landing-assets.internal/static/landing-build.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body && typeof body.id === 'string' && body.id ? body.id : null))
      .catch(() => null);
  }
  const id = await _ownBuildIdPromise;
  if (!id) _ownBuildIdPromise = null;
  return id;
}

async function refreshFreshness(env) {
  let result = null; // 'fresh' | 'stale' | null (inconclusive — leave `known` alone)
  try {
    const ownId = await ownBuildId(env);
    if (ownId) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FRESHNESS_CHECK_TIMEOUT_MS);
      try {
        const res = await fetch(new URL('/api/landing-build', env.ORIGIN), { signal: ctl.signal });
        if (res.ok) {
          originSucceeded();
          const body = await res.json().catch(() => null);
          // An empty string or a non-string id means the origin couldn't
          // compute its own id (server/src/api/app.py 503s on this too, but
          // treat a 200 with a bad body the same way defensively) — that is
          // NOT evidence of a mismatch, so it must stay inconclusive rather
          // than read as 'stale'.
          const originId = body && typeof body.id === 'string' && body.id ? body.id : null;
          if (originId) result = originId === ownId ? 'fresh' : 'stale';
        }
        // A non-2xx response is inconclusive too: keep the previous
        // verdict. `checkedAt` (set by the caller before this ran) already
        // backs the next attempt off by FRESHNESS_TTL_MS, so a
        // consistently-erroring origin isn't hit on every request.
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    /* origin napping, slow, unreachable, or aborted: inconclusive */
  }
  if (result) _freshness = { known: result, checkedAt: _freshness.checkedAt };
}

// Called synchronously from the request path. Schedules at most one
// background refresh per isolate at a time; a request that arrives while a
// check is already in flight (or the verdict is still fresh enough) is a
// no-op here. Returns the in-flight promise, if any, so `currentVerdict` can
// optionally wait on it briefly for a page request.
function maybeRefreshFreshness(env, ctx) {
  if (_inFlight) return _inFlight;
  const now = Date.now();
  // The TTL backs off retries the same way whether the last check was
  // conclusive or not — including while `known` is still 'unknown' (an
  // inconclusive check, e.g. a consistently-erroring origin, must not be
  // retried on every single request just because it never became fresh or
  // stale). checkedAt starts at 0, so the very first check on a fresh
  // isolate always fires regardless.
  if (now - _freshness.checkedAt < FRESHNESS_TTL_MS) return null;
  // Stamp checkedAt now, before the check itself runs, so a slow check (up
  // to FRESHNESS_CHECK_TIMEOUT_MS) — or one that concludes inconclusively —
  // can't be immediately re-triggered by the next request.
  _freshness = { known: _freshness.known, checkedAt: now };
  const promise = refreshFreshness(env).finally(() => {
    _inFlight = null;
  });
  _inFlight = promise;
  ctx.waitUntil(promise);
  return promise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The verdict to act on for this request. Triggers/continues the background
// check as needed. Asset requests never wait on it. A PAGE request made
// while the verdict is still 'unknown' (a fresh isolate's first requests)
// waits for the first in-flight check, capped at UNKNOWN_CHECK_WAIT_MS, so a
// visitor is less likely to get old HTML paired with a newer origin's
// scripts. This doesn't fully close that gap — see the README.
async function currentVerdict(env, ctx, isPageRequest) {
  const inFlight = maybeRefreshFreshness(env, ctx);
  if (isPageRequest && inFlight && _freshness.known === 'unknown') {
    await Promise.race([inFlight, sleep(UNKNOWN_CHECK_WAIT_MS)]);
  }
  return _freshness.known;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const page = PAGES[url.pathname];
    const method = request.method;
    const isAsset = ASSET_FILES.has(url.pathname) || ASSET_PREFIXES.some((p) => url.pathname.startsWith(p));
    const isGettable = method === 'GET' || method === 'HEAD';

    if (page && isGettable) {
      let previewFailed = false;
      if (url.pathname === '/join' && CRAWLER.test(request.headers.get('User-Agent') || '')) {
        const preview = await previewPage(request, env, url);
        if (preview) return preview;
        previewFailed = true;
      }
      const verdict = await currentVerdict(env, ctx, true);
      if (verdict === 'stale' && !previewFailed) {
        const proxied = await proxyLanding(request, env, url);
        if (proxied) return proxied;
      }
      const res = await env.ASSETS.fetch(new Request(new URL(page, url), request));
      return staticPage(res, url);
    }
    if (isAsset) {
      if (url.pathname === '/static/landing-build.json') {
        return withHeaders(await env.ASSETS.fetch(request), false);
      }
      if (url.pathname === '/static/version.json' || url.pathname === '/static/changelog.json') {
        const proxied = await proxyLanding(request, env, url, METADATA_PROXY_TIMEOUT_MS, true);
        if (proxied) return proxied;
        return withHeaders(await env.ASSETS.fetch(request), false);
      }
      const verdict = await currentVerdict(env, ctx, false);
      if (verdict === 'stale') {
        const proxied = await proxyLanding(request, env, url);
        if (proxied) return proxied;
      }
      return withHeaders(await env.ASSETS.fetch(request), false);
    }
    return proxy(request, env, url);
  },
};

export { PAGES, ASSET_FILES, CRAWLER };
