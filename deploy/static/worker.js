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
 * verdict and refreshes it in the background (see `checkFreshness`); while
 * it reads 'stale', pages and their files are proxied to the origin instead
 * of served from assets, so visitors always get the origin's current copy
 * even between Worker deploys.
 *
 * Build: python scripts/build_landing.py   Deploy: npx wrangler deploy -c wrangler.landing.jsonc
 */

// Every file the two pages load. Serving all of them here matters: the
// pages' scripts are `defer`, so one proxied script behind a napping server
// would hold up the waking screen itself.
const PAGES = { '/': '/index.html', '/index.html': '/index.html', '/join': '/join.html' };
const ASSET_PREFIXES = ['/static/fonts/'];
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
  '/static/og/home.png', // the generic link-preview image: crawlers fetch it while the server naps
  '/static/landing-build.json', // this build's id — see checkFreshness()
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
// WebSocket upgrades (status 101, no body to rewrite), and any response
// whose body we must not buffer.
async function rewriteOriginHost(res, env, url) {
  if (res.status === 101) return res;
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
  return rewriteOriginHost(res, env, url);
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
// The verdict is cached per isolate and refreshed at most every
// FRESHNESS_TTL_MS, in the background via ctx.waitUntil so it never delays
// the response in front of it. A timeout or network error leaves the
// previous verdict alone — the origin merely napping must never be read as
// "stale" (that would flip a healthy Worker into proxying everything to a
// server that isn't answering yet).
const FRESHNESS_TTL_MS = 60_000;
const FRESHNESS_CHECK_TIMEOUT_MS = 1500;

let _freshness = { known: 'unknown', checkedAt: 0 };
let _ownBuildIdPromise = null;

function ownBuildId(env) {
  if (!_ownBuildIdPromise) {
    _ownBuildIdPromise = env.ASSETS.fetch(new Request('https://landing-assets.internal/static/landing-build.json'))
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => (body && typeof body.id === 'string' ? body.id : null))
      .catch(() => null);
  }
  return _ownBuildIdPromise;
}

async function refreshFreshness(env, checkedAt) {
  let known = _freshness.known;
  try {
    const ownId = await ownBuildId(env);
    if (ownId) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), FRESHNESS_CHECK_TIMEOUT_MS);
      try {
        const res = await fetch(new URL('/api/landing-build', env.ORIGIN), { signal: ctl.signal });
        if (res.ok) {
          const body = await res.json();
          if (body && typeof body.id === 'string') known = body.id === ownId ? 'fresh' : 'stale';
        }
        // A non-ok response is treated like a timeout below: inconclusive,
        // keep the previous verdict, but still record checkedAt so a
        // consistently-erroring origin doesn't get hit on every request.
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    /* origin napping, slow, or unreachable: keep the previous verdict */
  }
  _freshness = { known, checkedAt };
}

// Called synchronously from the request path: never awaited, only schedules
// a background refresh (via ctx.waitUntil) when the cached verdict is stale
// enough to be worth rechecking.
function maybeRefreshFreshness(env, ctx) {
  const now = Date.now();
  if (_freshness.known !== 'unknown' && now - _freshness.checkedAt < FRESHNESS_TTL_MS) return;
  ctx.waitUntil(refreshFreshness(env, now));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const page = PAGES[url.pathname];
    const method = request.method;
    const isAsset = ASSET_FILES.has(url.pathname) || ASSET_PREFIXES.some((p) => url.pathname.startsWith(p));
    const isGettable = method === 'GET' || method === 'HEAD';

    if ((page || isAsset) && isGettable) maybeRefreshFreshness(env, ctx);

    if (page && isGettable) {
      if (url.pathname === '/join' && CRAWLER.test(request.headers.get('User-Agent') || '')) {
        const preview = await previewPage(request, env, url);
        if (preview) return preview;
      }
      if (_freshness.known === 'stale') return proxy(request, env, url);
      const res = await env.ASSETS.fetch(new Request(new URL(page, url), request));
      return staticPage(res, url);
    }
    if (isAsset) {
      if (_freshness.known === 'stale') return proxy(request, env, url);
      return withHeaders(await env.ASSETS.fetch(request), false);
    }
    return proxy(request, env, url);
  },
};

export { PAGES, ASSET_FILES, CRAWLER };
