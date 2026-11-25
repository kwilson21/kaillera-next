# kaillera-next

Play Super Smash Bros. for Nintendo 64 or Smash Remix with friends in your
browser. Bring a compatible ROM from your device. The game runs in EmulatorJS
with a patched mupen64plus-next WebAssembly core.
[Open Kaillera Next](https://kaillera-next.thesuperhuman.us/) ·
[Supported ROMs](server/config/known_roms.json) · [EmulatorJS](https://emulatorjs.org)

## How it works

1. Create a room and share its invite link or room code.
2. Friends can join as players or watch as spectators. Each browser running the
   emulator needs its own copy of the same ROM. Streaming guests and spectators
   can join without a ROM.
3. The host selects a netplay mode and starts the game.

Drop a `.z64`, `.n64`, `.v64`, or `.zip` file into the room. The browser can
keep ROMs in its local library using IndexedDB. The public
service does not host, distribute, or link to ROMs, and peer-to-peer ROM sharing
is disabled there.

### Netplay modes

| Mode | How it plays |
| --- | --- |
| **Rollback** (default) | Up to four players run the emulator locally and exchange inputs over WebRTC. The GGPO-style rollback engine predicts missing inputs and replays frames when a prediction is wrong. |
| **Lockstep** | Uses the same emulator and engine. Each frame waits for all players’ inputs before it runs. |
| **Streaming** | The host runs the emulator and sends live video and audio over WebRTC. Guests send their controller inputs back to the host. |

Spectators can watch a live match. In Rollback and Lockstep, a player joining
mid-match loads the host’s emulator state before catching up.

### Controller support

Use a keyboard, a browser-recognized gamepad, or the on-screen controls on touch
devices. In the room, open **Configure Controller → Quick Setup** to remap
buttons. The panel also has stick deadzone and sensitivity settings.

Switch 2 Pro Controller support is experimental and has been tested in Chrome
on macOS over USB-C. Connect the cable, choose **Connect Switch 2 Pro** in the
room before starting a game, then select the controller in the browser prompt
and press a button. This uses WebUSB.

## Quick start

Install Python 3.11 or later, Node.js 24 with npm, uv, and just. Run these
commands from the repository root. [uv](https://docs.astral.sh/uv/) ·
[just](https://github.com/casey/just)

```bash
just setup
DISABLE_HTTPS=1 just serve
```

`just setup` installs locked Python and Node dependencies and builds the
frontend bundles.

Open <http://localhost:27888/> on the machine running the server. Rollback and
Lockstep require cross-origin isolation for `SharedArrayBuffer`. The server
sends the required headers on the play page, and browsers treat
`http://localhost` as a secure context. Use trusted HTTPS when accessing the
server from another device.

### HTTPS and Redis

The server enables HTTPS when `certs/cert.pem` and `certs/key.pem` are present
and `DISABLE_HTTPS` is unset.

- For a trusted certificate on a LAN, install lego. Set `LEGO_EMAIL`,
  `LEGO_DOMAIN`, and `CLOUDFLARE_DNS_API_TOKEN` in `server/.env`. The token needs
  DNS edit access for the domain’s Cloudflare zone. Run `just certs` to issue or
  renew the certificate. Point the hostname at the server’s LAN IP in local DNS.
  [lego](https://go-acme.github.io/lego/)
- Run `just serve` and open `https://<your-domain>:27888/`. To include Redis,
  run `just dev` with Docker Compose available. Redis lets room state survive
  server restarts. Use `just redis-stop` to stop the container.

### Docker and deployment

```bash
docker build -t kaillera-next .
docker run --rm -p 127.0.0.1:27888:27888 kaillera-next
```

The image builds the frontend bundles and serves `/health` for health checks.
For hosting, use the [VPS setup](deploy/vps/README.md), [Render setup](deploy/render/README.md),
[Cloudflare Worker setup for the landing pages](deploy/static/README.md), or
[Docker Swarm stack](docker-compose.prod.yml).

The server entry point defines `PORT`, TLS, and `ALLOWED_ORIGIN`.
Room persistence reads `REDIS_URL` or the `REDIS_*` settings. With Redis configured,
startup retries transient connection failures and serves rooms after restoration succeeds.
The database defaults to SQLite and can use Cloudflare D1.
[Server entry point](server/src/main.py) · [Room persistence](server/src/state.py) ·
[Database backend](server/src/dbbackend/__init__.py)

The HTTP routes define the API and admin access, which requires `ADMIN_KEY`.
Socket.IO handlers define room and signaling events.
[HTTP routes](server/src/api/app.py) · [Socket.IO handlers](server/src/api/signaling.py)

## Architecture

FastAPI serves the web app and HTTP API. Socket.IO coordinates rooms, relays
WebRTC signaling, and carries game coordination messages. Player inputs and
streaming media travel over WebRTC, using a TURN relay when needed. The server
also stores match diagnostics and feedback.

- TypeScript implements the room and connection state machines. The build
  writes browser bundles to `web/static/dist/`. The gameplay scripts integrate
  those bundles with EmulatorJS. [TypeScript](web/src/) · [Gameplay scripts](web/static/)
- The Python server’s Socket.IO payload models generate the browser’s
  protocol types with `npm run protocol`. [Python server](server/src/) ·
  [Payload models](server/src/api/payloads.py)
- The repository includes the patched emulator core. If you change the core
  or C rollback engine, rebuild it using the build script and copy the
  resulting `.data`, `.js`, and `.wasm` files from `build/output/` into
  `web/static/ejs/cores/` together. [Build script](build/build.sh) ·
  [C rollback engine](build/kn_rollback/)
- Quint models cover room and connection behavior.
  [Models](specs/) · [Netcode diagrams](docs/netcode-diagrams.md) ·
  [Netplay invariants](docs/netplay-invariants.md)

## Contributing

Run `just build` to type-check, run the TypeScript tests, and bundle the
frontend. Run `just spec` to check the Quint models. For browser
tests, development conventions, and release history, see
[CONTRIBUTING.md](CONTRIBUTING.md) and the [changelog](CHANGELOG.md).

## License

[GPL-3.0](LICENSE)
