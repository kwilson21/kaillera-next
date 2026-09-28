# Render: the free fallback host

When the self-hosted server (`deploy/vps/`) is down, or before it exists,
the public site runs on [Render](https://render.com)'s free tier. It uses
the same Docker image and code, and needs no card. Rooms live in memory on
whichever server the hostname points to.

**What free means here** ([Render docs](https://render.com/docs/free)):

- The service sleeps after 15 minutes with no traffic. The next visitor
  waits about a minute while it wakes.
- Socket.IO heartbeats count as traffic, so it never sleeps while anyone is
  connected.
- It gets 750 free hours a month, enough to run all month.
- The container's disk resets on every restart or deploy, so the database
  lives in Cloudflare D1 and screenshots in Cloudflare R2 instead (see
  below). Gameplay doesn't depend on any of this.

## One-time setup (the owner)

1. Sign in at **dashboard.render.com** with GitHub, then choose **New →
   Blueprint** and pick this repo. Render reads `render.yaml` and creates
   the `kaillera-next` web service (free plan, Docker, deploys `main` on
   every merge).
2. When asked, fill in the two secret values in Render's form. They're kept
   in the service's environment, never in the repo or chat:
   - `CF_TURN_KEY_ID`
   - `CF_TURN_API_TOKEN`

   Render generates `ADMIN_KEY` and `IP_HASH_SALT` itself.

3. Wait for the first deploy, then open the service's
   `https://<name>.onrender.com` URL. The site works there before any DNS
   change.

## Database in Cloudflare D1

Without these three variables the server uses a local SQLite file, which
Render wipes on every restart. With them, it uses the D1 database and
applies `server/migrations/` there on startup.

1. Create the database: `npx wrangler d1 create kaillera-next-logs` (or
   Storage & Databases → D1 in the dashboard). Note its ID.
2. Create an API token: My Profile → API Tokens → Create Custom Token,
   permission **Account → D1 → Edit** on your account. A D1 token reaches
   every D1 database on the account, so keep it only in Render and a local
   `chmod 600` file.
3. In Render → Environment, add **all three in one save**. With only some
   set, the server refuses to start:
   - `CF_ACCOUNT_ID`
   - `D1_DATABASE_ID`
   - `D1_API_TOKEN`
4. Optional check from your machine, with the values in a file outside the
   repo (the dev server loads `.env`, so don't put them there):
   ```sh
   cd server && (set -a; . ~/.config/kaillera-next/d1.env; set +a; \
     KN_D1_LIVE=1 uv run --extra dev pytest ../tests/test_d1_live.py -q -s)
   ```

## Screenshots in Cloudflare R2

Without these the server keeps screenshots in a `blobs` folder next to the
database, which Render also wipes. With them, screenshot bytes go to R2 under
`matches/<match_id>/screenshots/`; the database keeps the key and size.

1. Create the bucket: `npx wrangler r2 bucket create kaillera-next-screenshots`.
2. Create a token: R2 → Manage API Tokens → Create API Token, permission
   **Object Read & Write**, applied to **that bucket only**. Copy the Access
   Key ID and Secret Access Key (the secret is shown once).
3. In Render → Environment, add **all three in one save** (with
   `CF_ACCOUNT_ID` already set for D1):
   - `R2_BUCKET`
   - `R2_ACCESS_KEY_ID`
   - `R2_SECRET_ACCESS_KEY`
4. Optional check from your machine, with the values in the same file as
   the D1 ones:
   ```sh
   cd server && (set -a; . ~/.config/kaillera-next/d1.env; set +a; \
     KN_R2_LIVE=1 uv run --extra dev pytest ../tests/test_blobstore.py -q -k live)
   ```

## Log retention

The server sweeps old logs a minute after it starts and every 6 hours
(`src/retention.py`). Defaults work; override in Render → Environment:

| Variable | Default | Meaning |
|---|---|---|
| `LOG_RETENTION_DAYS` | 7 | Normal matches are deleted this long after they end; resolved flagged matches this long after they're resolved |
| `FLAGGED_STALE_DAYS` | 180 | Flagged matches nobody has resolved or looked at are deleted after this long |
| `BUDGET_AUTO_FLAGGED_BYTES` | 209715200 (200 MB) | Past this much flagged data, automatic flags are recorded but no longer keep the match; feedback flags always do |

A match is flagged when its logs show a crash, freeze or desync, a client
reports a WASM crash, a vision check finds a visual desync, or a player sends
a bug report about it.

## Pointing the domain at Render (owner's OK)

1. In Render: service → **Settings → Custom Domains → Add**
   `kaillera-next.thesuperhuman.us`.
2. If the hostname is still the demo Worker's custom domain, detach it first
   (Workers & Pages → `kaillera-next` → Settings → Domains & Routes).
3. Create the record, DNS-only at first so Render can issue its certificate:
   ```sh
   python deploy/vps/deploy.py dns --target render --render-host <name>.onrender.com
   ```
4. Once Render shows the certificate as issued, you can turn on Cloudflare's
   proxy by re-running the command with `--proxied`.

## Switching to the self-hosted server and back

The hostname points at exactly one server. Switch while nobody is playing:
rooms on the old server end when their players reconnect elsewhere.
Matches already in progress keep playing, because gameplay goes directly
between the browsers.

- **To your server:** `python deploy/vps/deploy.py dns` (the tunnel).
- **Back to Render:** `python deploy/vps/deploy.py dns --target render --render-host <name>.onrender.com`

Both deployments build from `main` with the same settings, including
`ROM_SHARING_ENABLED=false`, so either can take over at any time.
