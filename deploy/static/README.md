# Static landing page: hosting proposal

**Status: proposal. Nothing here is live.** DNS, Render and Cloudflare
settings change only with the owner's OK (docs/landing-design.md §7.2 M0.9).

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
  ├─ /landing/*   ┘   landing CSS, fonts, images
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

- `GET /health` answers fast and needs no database.
- Public read-only CORS on `/health`, `/list`, `/room/*` and
  `/api/stats/public` for `ALLOWED_ORIGIN` plus `PUBLIC_ORIGINS`. Simple
  GETs only, no credentials. Needed for option B only; harmless for A.
- Keepalive behind `KEEPALIVE_SECONDS` (off by default; `render.yaml` has
  it commented out). With it on, each open play page fetches `/health`
  every few minutes, so the server can't nap under a live room.
- Room persistence behind `REDIS_URL` (commented out in `render.yaml`,
  with the Key Value instance next to it). Without it, rooms end on every
  restart or nap.

## Not changed until the pages exist

Invite links copied from a room still point at `/play.html?room=CODE`.
They switch to `/join?room=CODE` in M2, together with the invite page, so
no link ever points at a page that isn't deployed.
