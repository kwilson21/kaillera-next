# Host kaillera-next from a Mac (free)

The public site can run on any Mac you own. Cloudflare Tunnel connects the
Mac to `kaillera-next.thesuperhuman.us` through an outbound connection, so
there's no port forwarding, no router setup and no hosting bill. Game traffic
goes directly between players (or through Cloudflare TURN), so the Mac only
handles lobby and signaling traffic.

```
browser ──https/wss──▶ Cloudflare ──tunnel──▶ cloudflared (Mac) ─▶ 127.0.0.1:27890 server
```

**Trade-off:** the site is up only while the Mac is on, awake and online.
While the services run they keep a plugged-in Mac from sleeping. For 24/7,
move to a VPS later (`deploy/vps/`). The Cloudflare side doesn't change.

## What gets installed (all under your user, no sudo)

| Path                                                      | What it is                                               |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `~/kaillera-next-live`                                    | a clean checkout of `main`, separate from your dev clone |
| `~/Library/Application Support/kaillera-next/env`         | secrets, readable only by you                            |
| `~/Library/LaunchAgents/us.thesuperhuman.kn.server.plist` | the server on `127.0.0.1:27890`, restarted if it exits   |
| `~/Library/LaunchAgents/us.thesuperhuman.kn.tunnel.plist` | `cloudflared`, connecting that port to Cloudflare        |
| `~/Library/LaunchAgents/us.thesuperhuman.kn.update.plist` | every 5 min: deploys `main` if it moved                  |
| `~/Library/Logs/kaillera-next/`                           | `server.log`, `tunnel.log`, `update.log`                 |

The live checkout is kept apart from your dev clone on purpose: editing files
in the served checkout makes open game pages reload (`version-guard.js`).

## Setup

1. **The tunnel** (once). It must exist with its route to
   `http://127.0.0.1:27890`. From a session that has `CLOUDFLARE_API_TOKEN`:
   `python deploy/vps/deploy.py tunnel --service http://127.0.0.1:27890`.
   This creates the tunnel and its route and changes no DNS.
2. **The tunnel token.** In the Cloudflare dashboard, go to **Networking →
   Tunnels** (or **Zero Trust → Networks → Tunnels**), open `kaillera-next`
   and find the connector install command. Copy only the long token after
   `--token` (it starts with `eyJ`). Keep it out of chats and files. The
   installer asks for it at a hidden prompt.
3. **Install** from any clone of the repo:
   ```sh
   sh deploy/home/install.sh
   ```
   The installer:
   - installs `uv` and `cloudflared` with Homebrew if they're missing;
   - clones `~/kaillera-next-live`;
   - generates `ADMIN_KEY` and `IP_HASH_SALT`;
   - asks for the tunnel token, then the optional TURN key ID and API token
     (players on strict networks need TURN; press Enter to skip);
   - starts the services and checks that the server and tunnel are up.
4. **Check** http://localhost:27890/ on the Mac.
5. **Go live (DNS, owner's call).** The hostname is still attached to the demo
   Worker as a custom domain. Detach it (Workers & Pages → `kaillera-next` →
   Settings → Domains & Routes), then run `python deploy/vps/deploy.py dns`.

Re-run `sh deploy/home/install.sh --tokens` to replace the tokens.

## Day to day

- **Updates:** merges to `main` go live within 5 minutes. Rooms live in memory
  (no Redis here), so a restart ends every match. An update waits until
  nobody is in a room. `sh ~/kaillera-next-live/deploy/home/update.sh --force`
  deploys immediately.
- **Admin key:** `grep ADMIN_KEY ~/Library/Application\ Support/kaillera-next/env`
- **Status:** `launchctl list | grep kn` and the logs above.
- **Stop:** `sh ~/kaillera-next-live/deploy/home/uninstall.sh`. Add `--purge`
  to also delete the secrets, logs and live checkout.

## Hard rules this setup enforces

- `ROM_SHARING_ENABLED=false`: the server refuses ROM sharing and the page
  never sends or accepts a ROM. Players load their own ROM from disk.
- The server listens on `127.0.0.1` only, so nothing on your LAN can reach it.
  Only `cloudflared` can.
- Secrets live only in the env file, which only you can read.
