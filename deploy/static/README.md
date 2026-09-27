# Static landing page: hosting (option A, live)

**Status: live since 2026-09-26 (owner's OK).** The `kaillera-next-landing`
Worker serves `/` and `/join` on `kaillera-next.thesuperhuman.us` and
passes everything else to Render. Both proxy secrets are set, and the
server logs real visitor IPs (`SIO connect … (ip=<visitor>)`). Rolling back
is removing the route, in both the dashboard and `wrangler.landing.jsonc`;
the game server still serves `/` and `/join` itself, exactly as the Worker
does, and DNS already points the hostname at Render.

## The problem

The game server runs on Render's free plan (`render.yaml`). It sleeps after
15 minutes without traffic and takes about a minute to wake. Before the
Worker, it also served the front page, so the first visitor after a nap
stared at a loading tab for that minute. An invite link opened while it
slept did the same.

The redesign puts the front page (`/`) and the invite page (`/join`) on a
host that never sleeps. Those pages load instantly, wake the server in the
background and show the waking state until it answers. Everything else
(`/play.html`, `/demo.html`, the API, Socket.IO) stays on the game server.

## Option A (preferred): one domain, a Worker in front

```
kaillera-next.thesuperhuman.us
  ├─ /            ┐
  ├─ /join        ├─ Cloudflare Worker static assets (always up)
  ├─ /static/…    ┘   only the files those two pages load
  └─ everything else ─→ proxied by the same Worker to the game server
                        (kaillera-next.onrender.com, or the VPS tunnel)
```

- One origin: the page calls `/health`, `/list`, `/room/{code}` and
  `/api/stats/public` directly. No CORS, no second domain to explain.
- Invite links stay on the domain people already know:
  `https://kaillera-next.thesuperhuman.us/join?room=CODE`.
- Reuses what's already here: `wrangler.jsonc` deploys the static demo as
  a Worker with assets today, and the domain is already on Cloudflare
  (`deploy/vps/deploy.py dns`).
- Link previews for `/join`: crawlers fetch it while the host's server is
  awake (the host just created the room). The Worker asks the game
  server for the room's Open Graph tags with a ~1.5 s timeout and falls
  back to the generic card if it doesn't answer. Built (see below).

**What the owner changed** (done, in this order):
1. Added a `routes` entry for the hostname to a landing Worker (a new
   `wrangler.landing.jsonc`, so the demo Worker stays as it is). Its
   `assets.run_worker_first` is `true`, so the Worker decides every
   request itself (which paths come from its own static assets, which are
   proxied) rather than Cloudflare's asset layer deciding first.
2. Set the Worker's origin variable to the Render URL.
3. Switching back is deleting the route: the hostname goes back to
   pointing at the game server directly, as it did before.

## Option B (acceptable): two domains, a JS hand-off

```
static host (Cloudflare Pages / Worker)   game server (Render)
  /            ──fetch──→                  /health, /list, /room/*, /api/stats/public
  /join?room=C ──redirect──→               /play.html?room=C
```

- Nothing in front of the game server changes.
- The game server must allow the static origin to read the public
  endpoints: set `PUBLIC_ORIGINS=https://<static-origin>` (already
  supported, see below).
- Downside: two hostnames, and invite links show the static one.

## What M0 already ships for either option

- `GET /health` answers fast (with Redis on, it also pings Redis).
- Public read-only CORS on `/health`, `/list`, `/room/*` and
  `/api/stats/public` for `ALLOWED_ORIGIN` plus `PUBLIC_ORIGINS`. Simple
  GETs only, no credentials. Needed for option B only; harmless for A.
- Keepalive: each open play page fetches `/health` every
  `KEEPALIVE_SECONDS`, so the server can't nap under a live room. Set to
  300 in the Render dashboard.
- Room persistence: `REDIS_URL` points at the `kaillera-next-kv` Key Value
  instance (set in the dashboard), so rooms survive restarts and naps.

## The Worker (M2)

- `deploy/static/worker.js`: `/`, `/index.html` and `/join` come from the
  Worker's assets with the same headers the game server sends (strict CSP,
  no COEP, `no-store`). The static files those pages load come from assets
  too: every one of them is listed in `ASSET_FILES`, because the pages'
  scripts are `defer`red and one proxied script behind a napping server
  would hold up the waking screen. Everything else, WebSocket upgrades
  included, is passed to `ORIGIN`.
- Proxied HTML keeps the public host: the game server builds absolute URLs
  (OG tags, links) from the `Host` header it was asked on, which through a
  proxied request is the origin's own hostname. `worker.js` rewrites
  `https://<origin host>` → `https://<public host>` in the body of any
  proxied response whose content type is `text/html` (`/play.html`
  included — a shared link must not advertise `kaillera-next.onrender.com`)
  before returning it, preserving status and headers otherwise. Non-HTML
  bodies, a 101 WebSocket upgrade, and streaming responses are passed
  through untouched. Link previews use the same rewrite (see below).
- Link previews: a crawler fetching `/join` gets the game server's page
  (room name, host, live card) if it answers within 1.5 s, else the static
  page's generic tags.
- **Self-correcting when a Render release changes the landing pages.** If
  `web/index.html`, `web/join.html` or a file they load changes on Render
  but nobody redeploys this Worker, its cached assets would otherwise serve
  the old copies forever. Instead:
  - `server/src/landing_build.py` computes a "landing build id" — a stable
    content hash over exactly the files the Worker serves from assets (the
    two pages, the files they reference, `EXTRA`, and every self-hosted
    font). `scripts/build_landing.py` imports this module (rather than
    duplicating the logic) to write the *build's own* id into
    `dist-landing/static/landing-build.json`, and the game server imports
    the same module to compute its *current* id, lazily and cached, at
    `GET /api/landing-build`. The two can never compute the id
    differently, because they're the same function.
  - Each Worker isolate keeps an in-memory verdict (`fresh` / `stale` /
    `unknown`) plus when it was last checked. A page or landing-asset
    request never blocks on the check: it's answered from the cached
    verdict, and if that verdict is more than ~60 s old (or still
    `unknown`), a refresh runs in the background via `ctx.waitUntil` —
    fetching `ORIGIN/api/landing-build` with a ~1.5 s timeout and comparing
    it to the Worker's own id. The verdict only flips to `stale` on a
    definite mismatch; a timeout or error leaves the previous verdict
    alone, so a napping server is never mistaken for a stale Worker.
  - While the verdict reads `stale`, `/`, `/index.html`, `/join` and every
    `ASSET_FILES`/font path are proxied to the origin instead of served
    from assets — the pages the game server serves itself, OG tags and
    `?v=` cache-busting included, which is fine. A real redeploy
    (`npx wrangler deploy -c wrangler.landing.jsonc`) is still the way to
    get instant static pages back immediately, rather than waiting on the
    next background check.
- `scripts/build_landing.py` copies the pages and exactly the files they
  reference into `dist-landing/` (git-ignored), and fails if `worker.js`
  doesn't list one of them (`landing-build.json` included).
- `wrangler.landing.jsonc` is a separate Worker (`kaillera-next-landing`),
  so the demo Worker in `wrangler.jsonc` is untouched. `workers_dev` is off
  and `routes` binds `kaillera-next.thesuperhuman.us/*` (live since
  2026-09-26). `html_handling` is `none`: the Worker maps `/` and `/join`
  to their files itself, and Cloudflare's default would answer those files
  with redirects that loop.
- `tests/test_landing_worker.py` runs the Worker against fakes, and against
  the real local runtime (`wrangler dev`) when wrangler is installed
  (`npm install`, or point `WRANGLER` at a binary).
  `tests/test_landing_build.py` checks `landing_build.py` against the
  repo's `web/` directory and that editing a landing file moves the id.

**Redeploying**, after any change to the landing pages or `worker.js`:

```sh
python scripts/build_landing.py
npx wrangler deploy -c wrangler.landing.jsonc   # keeps the route and secrets
```

The route was added and both proxy secrets were set once, on first-time
setup (2026-09-26). Secrets persist across `wrangler deploy`, so a routine
redeploy doesn't need to touch them.

## Rotating the proxy secret

`KN_PROXY_SECRET` on the game server may hold a comma-separated list
(`server/src/ratelimit.py`), so a rotation never has a gap where every
visitor collapses into the Worker's single address:

1. Set the Render env var `KN_PROXY_SECRET` to `"new,old"` (the new secret
   first, the current one kept alongside it) and wait for Render to finish
   redeploying with it.
2. Generate the new secret's value if you haven't already
   (`openssl rand -hex 32`), then set it on the Worker:
   `npx wrangler secret put PROXY_SECRET -c wrangler.landing.jsonc`.
3. Confirm the connect log shows real visitor IPs (below) — that's the only
   way to confirm the two sides agree, since a secret can't be read back
   once it's set.
4. Set Render's `KN_PROXY_SECRET` to just the new value, dropping the old
   one.

Render restarting for step 1 (and step 4) drops live Socket.IO connections
— rooms survive it via Redis, but players briefly reconnect — so rotate at
a quiet time.

Confirm a real visitor IP — not the Worker's
own Cloudflare address (something like `2a06:98c0:...`) — shows up in the
server's connect log (`server/src/api/signaling.py`):

```
SIO connect <sid> (ip=<visitor IP>)
```

If it instead shows the Worker's address (or `unknown`), the two secrets
are out of sync in one of two ways, and each side warns about its own half
— neither ever logs the secret itself:

- **The Worker has no `PROXY_SECRET`.** It never sends `X-KN-Client-IP` at
  all, and logs `PROXY_SECRET is not set` once per isolate (`wrangler
  tail`). If `KN_PROXY_SECRET` *is* set on the server, the server notices
  the Worker's own address coming back with no forwarded header and warns
  once per process ("a request came from a Cloudflare Worker without
  X-KN-Client-IP — is PROXY_SECRET set on the landing Worker?").
- **The two secrets don't match, or the server has none configured.** The
  Worker still sends `X-KN-Client-IP`, so the server warns
  (`X-KN-Client-IP present but ...`) and falls back to the Worker's
  address instead.

Either way, until it's fixed every visitor is folded into the Worker's
single address: one 20-connection limit and one set of rate limits for
the entire site, not per visitor.

**Visitor IPs.** Cloudflare sets `CF-Connecting-IP` on a Worker's
subrequests to the Worker's own address, so without help the game server
would see every visitor as one IP: one connection limit and one rate limit
for everyone. The Worker forwards the visitor's IP in `X-KN-Client-IP` with
the shared secret in `X-KN-Proxy-Auth` (and strips any a visitor sends);
the server trusts that header only when the secret matches
(`server/src/ratelimit.py`). Both secrets were set before the route went on.

Rolling back is removing the route, in both the Cloudflare dashboard and
`wrangler.landing.jsonc` — leaving it in the config only means the next
deploy re-adds it. With the route gone, traffic reaches Render directly,
since DNS for the hostname already points there (a proxied CNAME to
`kaillera-next.onrender.com`). A change to `web/index.html`, `web/join.html`
or the files they load no longer needs an immediate redeploy of this
Worker: its freshness check (above) notices within about a minute and
proxies to the game server until the next `npx wrangler deploy` picks up
the new copies. Redeploy anyway for instant static pages rather than a
minute of proxying.

## Invite links

Room invite links point at `/join?room=CODE` (M2). The game server serves
`/join` too, so the links work before, during and after the Worker switch.
