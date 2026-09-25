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
- Logs and the local SQLite database reset on every restart or deploy.
  Gameplay doesn't depend on them.

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
