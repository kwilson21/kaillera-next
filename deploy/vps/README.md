# kaillera-next on a VPS (Hetzner Cloud + Cloudflare Tunnel)

One small server runs the whole site: the FastAPI/Socket.IO server, Redis
and `cloudflared`. Cloudflare terminates HTTPS and forwards
`kaillera-next.thesuperhuman.us` down the tunnel. The server has **no open
inbound port and no SSH**. It updates itself: every 5 minutes it pulls
`main` and rebuilds if `main` moved, so **merging to main deploys**.

```
browser ──https/wss──▶ Cloudflare ──tunnel──▶ cloudflared ─▶ app:27888 ─▶ redis
browser ◀──WebRTC (P2P, or relayed by Cloudflare TURN)──▶ browser
```

## Files

| File              | What it does                                             |
| ----------------- | -------------------------------------------------------- |
| `compose.yml`     | the stack (`docker compose`, built from the checkout)    |
| `cloud-init.yaml` | first boot: Docker, clone, secrets file, update timer    |
| `kn-update.sh`    | pull + redeploy; run by `kn-update.timer`                |
| `deploy.py`       | creates the tunnel, firewall and server through the APIs |

## One-time setup (the owner)

Put every value in the cloud environment's **environment variables**,
never in a file or in chat. Only the names are listed here.

1. **Hetzner Cloud:** create a project, then Security → API tokens →
   _Read & Write_. Save it as `HCLOUD_TOKEN`.
2. **Cloudflare API token** (`CLOUDFLARE_API_TOKEN`, plus
   `CLOUDFLARE_ACCOUNT_ID`) with:
   - Account → Cloudflare Tunnel → Edit
   - Zone `thesuperhuman.us` → DNS → Edit (only for the `dns` step)
3. **Cloudflare TURN:** Dashboard → Realtime → TURN Server → Create. Save
   the key id as `CF_TURN_KEY_ID` and the API token as `CF_TURN_API_TOKEN`.
   Without them, players behind strict NATs can't connect. Usage: 1,000 GB
   a month free, then $0.05/GB.
4. **Network access:** add `api.hetzner.cloud` to the environment's
   allowed domains.

## Deploy

```sh
python deploy/vps/deploy.py up       # tunnel + firewall + server (~5 min to boot)
python deploy/vps/deploy.py status   # server running, tunnel connected?
python deploy/vps/deploy.py dns      # DNS cutover: only with the owner's OK
```

`up` defaults to a `cpx21` (3 vCPU / 4 GB) in Ashburn (`--location`,
`--type` to change). The server only does signaling, so its location
barely matters to players: game traffic is peer to peer.

`dns` points the hostname at the tunnel. It refuses while the hostname is
still attached to the demo Worker as a custom domain. Detach that first.

## Secrets on the server

- `ADMIN_KEY`, `REDIS_PASSWORD` and `IP_HASH_SALT` are generated on first
  boot and never leave the machine. They live in `/etc/kaillera-next/env`
  (root-only).
- The tunnel token and the TURN credentials reach the server through
  cloud-init user data. Hetzner keeps user data, so anyone holding the
  `HCLOUD_TOKEN` can read them. To rotate them, rotate them at Cloudflare
  and recreate the server.
- To read `ADMIN_KEY`: open the Hetzner web console and run
  `grep ADMIN_KEY /etc/kaillera-next/env`. Hetzner emails the root password
  when the server is created.

## Hard rules this deploy enforces

- `ROM_SHARING_ENABLED=false` is set in `compose.yml`. The server refuses
  to turn ROM sharing on and doesn't relay `rom-signal`. The page won't
  send or accept a `rom-transfer` channel.
- No ROMs ship: `.dockerignore` excludes ROM paths, and players load their
  own ROM from disk.
