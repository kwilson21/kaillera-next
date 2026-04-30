# Contributing to kaillera-next

Thanks for your interest in contributing! This project is open to contributions of all kinds — code, bug reports, testing, gamepad profiles, and ideas.

## Getting started

### Prerequisites

- Python 3.11+
- [uv](https://docs.astral.sh/uv/) (recommended) or pip for dependency management
- [just](https://github.com/casey/just) (command runner)
- Node.js (for Prettier formatting)
- Optionally: Docker (for Redis), [lego](https://go-acme.github.io/lego/) + a
  Cloudflare API token (for HTTPS dev — see `just certs` in the README)

### Setup

```bash
# Install dependencies
just setup

# Simplest path — HTTP, no Redis, no HTTPS
just serve
# → http://localhost:27888/
```

This gets you a running server for exploring the lobby, streaming mode, and the
codebase. See [README.md](README.md) for HTTPS setup (required for rollback mode)
and Docker deployment.

## Ways to contribute

### Bug reports

Found something broken? [Open an issue](https://github.com/kwilson21/kaillera-next/issues/new) with:
- What you were doing
- What happened vs. what you expected
- Browser + OS + device (especially mobile)
- Console errors if any

### Testing

The most valuable contribution right now is just **using the app** and reporting what's confusing, broken, or missing. Try it on different devices, browsers, and network conditions.

### Gamepad testing

If you have a controller that doesn't work well or has wrong mappings, open an issue with:
- Controller name (as shown in the overlay)
- Browser + OS
- What's wrong (buttons swapped, analog drift, etc.)

### Code contributions

1. Fork the repo
2. Create a branch (`git checkout -b my-fix`)
3. Make your changes
4. Run the pre-commit hooks (`pre-commit run --all-files`)
5. Open a PR — **the title must use a conventional commit prefix**:

| Prefix | When to use | Version bump |
|--------|-------------|-------------|
| `feat:` | New feature | minor (0.X.0) |
| `fix:` | Bug fix | patch (0.0.X) |
| `docs:` | Documentation only | none |
| `chore:` | Maintenance, deps | none |
| `refactor:` | Code restructuring | none |
| `test:` | Adding/fixing tests | none |

Examples: `feat: add multiplayer chat`, `fix: resolve audio crackling on iOS`

PRs are **squash merged** — the PR title becomes the commit message on main. If the
title starts with `feat:` or `fix:`, a version bump and changelog entry are created
automatically. Other prefixes are valid but won't trigger a release.

### Ideas and suggestions

Have an idea for a feature? Open an issue tagged with your suggestion. Even rough ideas are welcome — we can figure out scope together.

---

## Developer guide

### Code architecture

#### Pattern: IIFEs + window globals

All frontend JS uses **immediately-invoked function expressions** (IIFEs) with
`window.*` exports. This is intentional — EmulatorJS patches and overrides
browser globals extensively, and ES modules would break interop with its runtime.
Do not convert to ES modules.

```js
// Every module follows this pattern:
(function () {
  'use strict';
  // ... private state and functions ...
  window.ModuleName = { /* public API */ };
})();
```

#### Cross-module communication: KNState

Modules communicate through `window.KNState` (defined in `kn-state.js`). Each
property documents its writer and readers inline:

```js
window.KNState = {
  remapActive: false,    // play.js → rollback.js, streaming.js
  touchInput: {},        // virtual-gamepad.js → rollback.js, streaming.js
  peers: {},             // rollback/streaming.js → play.js
  frameNum: 0,           // rollback.js → play.js info overlay
  delayAutoValue: 2,     // play.js → rollback.js
  romHash: null,         // play.js → gamepad-manager.js
};
```

To trace data flow between modules, grep for the `KNState` property name.

#### Script load order

Scripts are loaded in `play.html` in dependency order. Later scripts expect
earlier ones to have set up their `window.*` exports:

1. `api-sandbox.js` — saves native browser APIs before anything overrides them
2. `core-redirector.js` — intercepts fetch/XHR for patched WASM core
3. `storage.js` — safe localStorage/sessionStorage wrapper
4. `kn-state.js` — shared state namespace
5. `gamepad-manager.js` — gamepad profiles and mapping
6. `shared.js` — input encoding/decoding, cheats, wire format
7. `virtual-gamepad.js` — touch controls for mobile
8. `netplay-rollback.js` — rollback engine (exposes `window.NetplayRollback`, plus `window.NetplayLockstep` as a legacy alias)
9. `netplay-lockstep.js` — deprecated 16-line compat shim that warns once; loaded after rollback so cached `play.html` requests don't 404
10. `netplay-streaming.js` — streaming engine (exposes `window.NetplayStreaming`)
11. `controller-settings.js` — in-game controller settings panel
12. `play.js` — page orchestrator (connects everything)
13. `version.js` — version display + changelog modal
14. `feedback.js` — in-app feedback collection

#### Server structure

The Python server is small (~3,400 lines across 8 files):

| File | Purpose |
|---|---|
| `main.py` | Entry point — mounts FastAPI, Socket.IO, static files, HTTPS |
| `api/app.py` | REST endpoints, security headers (COOP/COEP/CSP), admin API |
| `api/signaling.py` | Socket.IO event handlers — rooms, WebRTC relay, game data |
| `api/payloads.py` | Pydantic v2 payload models + `@validated` decorator for Socket.IO events |
| `api/og.py` | Open Graph image generation (Playwright HTML screenshots) |
| `state.py` | Redis-backed room persistence for zero-downtime deploys |
| `ratelimit.py` | Per-IP rolling-window rate limiting |
| `db.py` | SQLite database (aiosqlite), Alembic migrations, session/feedback storage |

#### Frontend file map

| File | Lines | What it does | Talks to |
|---|---|---|---|
| `play.js` | ~5,330 | Page orchestrator: Socket.IO, overlay, ROM handling, gamepad wizard, engine lifecycle | everything |
| `netplay-rollback.js` | ~11,700 | Primary engine: GGPO-style C-level rollback (4P mesh WebRTC, prediction + replay, frame stepping, desync/resync); strict lockstep is the silent stall fallback inside this file | play.js, KNState, shared.js |
| `netplay-lockstep.js` | ~16 | Deprecated compat shim — emits a `console.warn` and exists only so cached `play.html` requests don't 404. Remove in a follow-up deploy. | (none) |
| `netplay-streaming.js` | ~1,530 | Streaming engine (host video → guests via WebRTC MediaStream) | play.js, KNState, shared.js |
| `shared.js` | ~880 | Input encoding/decoding, N64 button map, cheat codes, wire format | rollback, streaming |
| `gamepad-manager.js` | ~420 | Profile-based gamepad detection, deadzone, analog mapping | play.js, KNState |
| `controller-settings.js` | ~980 | In-game controller settings panel (deadzone, sensitivity, profiles) | play.js, gamepad-manager |
| `virtual-gamepad.js` | ~600 | On-screen touch controls for mobile | KNState |
| `kn-audio.js` | — | AudioWorklet pump + rollback audio capture | rollback, play.js |
| `kn-desync-detector.js` | — | Field-granular cross-peer desync detection (RDRAM probes) | rollback |
| `kn-diagnostics.js` | — | Rollback diagnostics ring buffer (RB-CHECK, audit log) | rollback |
| `kn-vision-client.js` | — | Claude / GPT-4o vision client for screenshot-diff desync analysis | rollback |
| `feedback.js` | ~480 | In-app feedback collection UI | play.js |
| `api-sandbox.js` | — | Saves/restores native rAF, performance.now, getGamepads | rollback, core-redirector |
| `core-redirector.js` | — | Intercepts EJS core download → serves patched WASM from IDB | api-sandbox |
| `storage.js` | ~24 | Safe localStorage/sessionStorage wrapper (KNStorage) | all modules |
| `kn-state.js` | ~37 | Cross-module shared state namespace | all modules |
| `version.js` | ~350 | Version display + changelog modal | play.js |
| `version-guard.js` | — | Cross-tab version mismatch guard — forces reload when a deploy lands | play.js |
| `ejs-loader.js` | — | EmulatorJS loader shim (booting + script setup hooks) | play.js |
| `lobby.js` | ~175 | Room creation and join form on index.html | — |
| `admin.js` | — | Admin dashboard logic (sessions, events, feedback, screenshots) | admin.html only |

### Conventions

- **Modern ECMAScript** — `const`/`let` (never `var`), arrow functions, template
  literals, `async`/`await`, optional chaining. No ES modules (see above).
- **Python** — formatted by ruff, type hints encouraged.
- **HTML/CSS** — formatted by prettier.
- **No unnecessary comments** — code should be self-evident. Add comments only
  where the *why* isn't obvious from the *what*.
- **Commit messages** — use [conventional commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, etc. This drives auto-versioning.
- Pre-commit hooks handle formatting automatically.
- A **post-commit hook** auto-bumps the version on `feat:`/`fix:` commits to main.

### Docs layout

```
docs/
  roadmap.md                 — V1 feature roadmap (all phases complete)
  mvp-plan.md                — MVP implementation plan (all items shipped or cut)
  superpowers/
    specs/YYYY-MM-DD-*.md    — Design specs
    plans/YYYY-MM-DD-*.md    — Implementation plans
```

Design specs and plans are **historical snapshots** — they reflect decisions and
code state at the time they were written. The source of truth is always the code
itself. Use these docs for context on *why* something was built a certain way, not
as a reference for current behavior.

### Running the server

```bash
just serve          # HTTP, no Redis — simplest path
just dev            # HTTPS + Redis — full stack (needs lego/Cloudflare certs from `just certs` + Docker)
just redis          # Start just Redis in background
just redis-stop     # Stop Redis
```

### Formatting and linting

```bash
just fmt            # Auto-format everything
just lint           # Check without fixing
just check          # Run pre-commit on all files
```

### Tests

```bash
cd server && uv run pytest          # Unit tests
cd server && uv run pytest tests/   # E2E (needs Playwright browsers)
```

#### Virtual Gamepad visual regression (100 devices × 4 variants)

Requires: `npm install playwright` and a local static server on port 18888.

```bash
cp tests/vgp-test.html web/vgp-test.html
cd web && python3 -m http.server 18888 &
node tests/vgp-device-test.mjs
open tests/vgp-screenshots/index.html   # inspect results
kill %1                                  # stop the server
rm web/vgp-test.html
```

Screenshots are written to `tests/vgp-screenshots/` (gitignored).

## License

By contributing, you agree that your contributions will be licensed under the [GPL-3.0 License](LICENSE).
