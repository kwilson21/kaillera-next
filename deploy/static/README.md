# Static landing page: hosting proposal

**Status: option A chosen by the owner (2026-09-26). The Worker is built
(M2) but not deployed and has no route.** The route is switched on in
Cloudflare at launch, with the owner. Until then the game server serves
`/` and `/join` itself, exactly as the Worker would.

## The problem

The game server runs on Render's free plan (`render.yaml`). It sleeps after
15 minutes without traffic and takes about a minute to wake. Today it also
serves the front page, so the first visitor after a nap stares at a
loading tab for that minute. An invite link opened while it sleeps does the
same.

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
  awake (the host just created the room). The Worker can ask the game
  server for the room's Open Graph tags with a ~1.5 s timeout and fall
  back to the generic card if it doesn't answer. That is an M2 detail.

**What the owner would change** (each step on your OK, in this order):
1. Add a `routes` entry for the hostname to a landing Worker (a new
   `wrangler.landing.jsonc`, so the demo Worker stays as it is), with
   `run_worker_first` for everything except the static paths.
2. Set the Worker's origin variable to the Render URL (or the tunnel).
3. Switching back is deleting the route: the hostname goes back to
   pointing at the game server directly, as now.

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
  included, is passed to `ORIGIN` unchanged.
- Link previews: a crawler fetching `/join` gets the game server's page
  (room name, host, live card) if it answers within 1.5 s, else the static
  page's generic tags.
- `scripts/build_landing.py` copies the pages and exactly the files they
  reference into `dist-landing/` (git-ignored), and fails if `worker.js`
  doesn't list one of them.
- `wrangler.landing.jsonc` is a separate Worker (`kaillera-next-landing`),
  so the demo Worker in `wrangler.jsonc` is untouched. `workers_dev` is off
  and `routes` is commented out.

**Deploying, on the owner's OK:**

```sh
python scripts/build_landing.py
npx wrangler deploy -c wrangler.landing.jsonc   # uploads; still no route
# then uncomment "routes" (or add the route in the dashboard) and deploy again
```

Rolling back is removing the route. Deploy again after any change to
`web/index.html`, `web/join.html` or the files they load, or the Worker
serves the old copies while the game server has the new ones.

## Invite links

Room invite links point at `/join?room=CODE` (M2). The game server serves
`/join` too, so the links work before, during and after the Worker switch.
