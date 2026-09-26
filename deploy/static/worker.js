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

// The static pages carry generic preview tags with a host placeholder.
async function staticPage(res, url) {
  const html = (await res.text()).replaceAll('https://__KN_HOST__', `https://${url.host}`);
  return withHeaders(new Response(html, res), true);
}

async function previewPage(request, env, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(new URL(url.pathname + url.search, env.ORIGIN), {
      headers: { 'User-Agent': request.headers.get('User-Agent') || '', Accept: 'text/html' },
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

function proxy(request, env, url) {
  const target = new URL(url.pathname + url.search, env.ORIGIN);
  return fetch(new Request(target, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const page = PAGES[url.pathname];
    const method = request.method;
    if (page && (method === 'GET' || method === 'HEAD')) {
      if (url.pathname === '/join' && CRAWLER.test(request.headers.get('User-Agent') || '')) {
        const preview = await previewPage(request, env, url);
        if (preview) return preview;
      }
      const res = await env.ASSETS.fetch(new Request(new URL(page, url), request));
      return staticPage(res, url);
    }
    if (ASSET_FILES.has(url.pathname) || ASSET_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return withHeaders(await env.ASSETS.fetch(request), false);
    }
    return proxy(request, env, url);
  },
};

export { PAGES, ASSET_FILES, CRAWLER };
