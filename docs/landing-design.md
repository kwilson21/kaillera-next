# Landing page design — kaillera-next

> **Status:** Phase 1 (Intent and people) — interview in progress.
> Design only. No code, PRs or deploys until the owner says "move to build".
>
> This is the single record of what we decided about the public landing page
> and *why*. It is updated at the end of every phase. Open questions live at
> the bottom of each phase until answered; answers are folded into the text
> with the reason attached.

Process (agreed 2026-09-25):

| Phase | Output | Gate |
|---|---|---|
| 1. Intent and people | One-page Design Brief | Owner interview, owner review |
| 2. Experience and content | Section-by-section narrative, draft copy, 2–3 visual directions | Owner picks/mixes |
| 3. User flows | Step-by-step flows incl. failure paths + feelings | Owner + real-player questions |
| 4. Wireframes | Low-fi boxes for landing (desktop/mobile), invite-link, ROM-needed, server-waking | Owner feedback, iterate |
| 5. Image prompts | Ready-to-paste GPT image prompts, 3 variants per screen, no Nintendo IP | Owner brings images back, joint critique |
| 6. Put it in front of people | Test guide for 3–5 real players | Owner returns with feedback, revise |
| Build plan | Sections, states, copy, assets, accessibility, slow-phone performance | Handed to a separate build session |

Principle: **we never build for humans without humans in mind.** Gaps are
filled by asking, not guessing. Where real players' input matters more than the
owner's, the doc says who to ask and exactly what to ask.

---

## 0. Facts from the repo that shape the page

Gathered 2026-09-25 from CLAUDE.md, README.md, docs/launch-copy.md,
docs/roadmap.md, web/index.html, web/play.html, web/demo.html,
web/lag-test.html, web/static/lobby.js, web/static/version.js,
server/config/known_roms.json. Facts, not tone.

**What the product is**
- Open a link, play N64 games online with friends in the browser. No emulator
  install. EmulatorJS runs a patched mupen64plus-next WASM core.
- The server only does rooms + WebRTC signaling (+ save-state relay for late
  join). Gameplay is peer to peer once connected.
- Rollback netplay is the default and the technical centrepiece: GGPO-style
  C engine, full-mesh WebRTC, up to 4 players. Streaming mode (host streams
  video) exists as an alternative. Spectators, late join, gamepad profiles and
  remapping, on-screen touch controls for mobile all exist.
- Tested mobile↔mobile (iPhone/iPad Safari) and desktop Chrome with
  bit-identical state.

**Current lobby (web/index.html)** — a single card: title, tagline
"Play N64 online with friends — no download needed", name field,
**Create Room**, "or join a game" + room code/invite link field with **Join**
and **Spectate**, a "Supported ROMs" list, footer with author credit, GitHub,
Ko-fi "Support", About, version/changelog.
- Create → `/play.html?room=CODE&host=1&name=…&mode=rollback`
- Invite link → `/play.html?room=CODE` (guest auto-joins); spectate adds
  `&spectate=1`. Player name persists in localStorage.
- The play page's pre-game overlay has the ROM drop zone ("Tap or drop ROM
  file here"), player list, Invite/copy-link button, controller setup,
  host options.

**ROMs — the hard constraint**
- Only three ROMs are supported today (server/config/known_roms.json):
  Super Smash Bros. (US), Smash Remix 2.0.0 (US), Smash Remix 2.0.1 (US).
  The lobby says so plainly: "Only these three ROMs work right now."
- Players bring their own file (.z64/.n64/.v64/.zip), drag-and-drop, cached
  in IndexedDB. Unknown ROMs load but show "not a supported ROM, it may not
  work".
- **Tension to resolve (Phase 1 Q):** the owner's hard rule for this page is
  "no ROMs or copyrighted game files are ever hosted or shared". The product
  currently has an opt-in host→guest P2P ROM transfer ("Share ROM with
  players" host checkbox; guest sees "Accept from Host — by accepting you
  confirm you own a legal copy"). The landing page must not advertise this
  unless the owner decides it stays and is fine to mention.

**Netcode claims — rules we must follow (docs/launch-copy.md)**
- Say: "Rollback hides the network round-trip locally." "Lockstep waits the
  full round-trip every frame; rollback runs immediately." "Feels like offline
  play under ~150 ms of network lag."
- Never say: "zero lag", "no input delay", "rollback fixes lag",
  "eliminates rollbacks", "faster than offline".
- Numbers with sources: rollback perceived lag ~1–2 frames (17–33 ms);
  lockstep ~6 frames (~100 ms) typical; ~150 ms RTT is where rollback feels
  offline. (SnapNet, coherence docs, Wikipedia GGPO/Netcode.)
- Existing proof pages: `/demo.html` (drop a ROM, lag slider 0–110 ms RTT,
  Rollback ON/OFF toggle, auto-compare, synthetic P2 in-tab; explainers
  already written in the right tone) and `/lag-test.html` (no ROM needed:
  press SPACE, see input vs response pulse, lag slider 0–300 ms, mode toggle).
- Existing landing blurb draft (in launch-copy.md, written for
  thesuperhuman.us): "N64 netplay for the modern web. Drop a ROM, share a
  link, play with friends. No installs, no router config, no screen-share…"
  with three CTAs: Try the rollback demo / Lag visualizer / Create a room.

**Story material already written (About modal, web/static/version.js)**
- Five first-person paragraphs: grandparents' house, Sonic on an emulator from
  a data CD; Project64 and SSB64; discovering the netplay tab and Kaillera,
  friends from all over; wanting to fix the emulator/server/clients at age
  9–12 but C++/Java felt impossible; "Now, with the help of AI, I'm finally
  building what I always wanted Kaillera to be."
- A lineage list from Kaillera (2001, Christophe Thibault) through EmuLinker,
  EmuLinker SF, SupraClient, n02, Project64k, AQZ NetPlay, Ownasaurus Client,
  EmuLinker X (Near, Firo, Ownasaurus, Agent 21), EmuLinker-K, Kaillera Reborn,
  to kaillera-next (Agent 21). Footer credit: "by Kazon Wilson (Agent 21) ·
  Inspired by Kaillera by Christophe Thibault". GPL-2. Ko-fi link exists.

**Environment constraints**
- Rollback needs HTTPS + cross-origin isolation (SharedArrayBuffer). The play
  page only *logs* missing capabilities today; there is no user-facing
  "unsupported browser" screen.
- The server may be on a free tier that sleeps; first visitor after idle can
  wait ~1 minute. There is no "waking up" UI anywhere today. **Phase 1 Q:**
  is the landing page served by that same sleeping server (so the page itself
  is what stalls), or from static hosting that is always up?
- Launch plan (launch-copy.md): niche communities first (r/Smash64,
  r/smashbros, r/emulation), then Twitter/X with demo video, r/fightinggames,
  Show HN last. Discords: SSB64 modding, EmulatorJS, Fightcade.

---

## 1. Phase 1 — Intent and people

### Interview log

Questions are asked a few at a time. Answers are recorded verbatim-ish with
the date, then distilled into the Design Brief below.

#### Batch 1 (asked 2026-09-25) — audience, first 60 seconds, two structural facts
_Awaiting answers._

### Design Brief
_Pending — written after the interview, then reviewed by the owner._

---

## 2. Phase 2 — Experience and content
_Not started._

## 3. Phase 3 — User flows
_Not started._

## 4. Phase 4 — Wireframes
_Not started._

## 5. Phase 5 — Image prompts
_Not started._

## 6. Phase 6 — Testing with real players
_Not started._

## 7. Build plan
_Not started._

---

## Decision log

| Date | Decision | Why | Phase |
|---|---|---|---|
| 2026-09-25 | Design-only session; single doc at docs/landing-design.md updated per phase | Owner's process; keep reasons with decisions | 0 |
