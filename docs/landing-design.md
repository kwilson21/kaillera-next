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

**Q1. Who is this for, in priority order?**
Owner: *New gamers who enjoy an unserious fighting game that has a unique
structure and style. They're looking to easily play with other people, make
friends and form a community around it.* Added: *not just new players — Super
Smash Bros. vets should feel at home too, especially those who used the old
Kaillera.*

→ Two co-primary audiences, not a ranked list:
  - **Newcomers** — drawn by an unserious, distinctive fighting game; want
    people to play with, friends, a community. Have likely never used an
    emulator.
  - **Smash 64 veterans**, above all **old Kaillera users** — must feel at
    home, recognised, not talked down to.
  Not named by the owner (so not primary): competitive netcode scrutineers,
  HN/dev crowd, stream/Discord spectators. Friends-from-an-invite-link are a
  *mode of arrival* for either group rather than a separate audience.
  (Confirm in batch 2.)

**Q2. First 60 seconds / what makes them leave?**
Owner (for everyone, not per group): *If they can't easily figure out what
this product is, how it serves them and how to jump in and use it in the first
60 seconds, it's gonna be bad. What would make them leave is selling them a
false hope or dream or a bunch of hype. We want them to be excited, but they
should be able to skip the hype and jump directly into a game if they're a
curious veteran or just someone who wants to play. All options should be easy.*

→ Design rules derived:
  - In 60 seconds a visitor must know **what it is, what it does for them, and
    how to start** — with no scrolling required for the "how to start".
  - **No hype, no false promises.** Excitement comes from honesty and the
    thing itself (a real game, a real demo), not adjectives. This reinforces
    docs/launch-copy.md.
  - **Skippable story.** A "just play" path is always visible and one action
    away; the narrative is there for people who want it.
  - Per-group first-60-second goals are still unvalidated → ask real players
    in Phase 6 (newcomer: "what do you think this is / what would you do
    first?"; veteran: "what do you expect to happen when you click Create
    Room?").

**Q3. Where is the landing page served from?**
Owner: *The landing page should be static, as waiting >1 minute just to see
anything is bad UX. We could use both: an interactive loading page. The
machine boots up in the background while the user figures out what the product
is and how to use it. A nice callback to long loading screens in the early
console days.*

→ Decision: **landing page on always-up static hosting.** The sleeping server
  is woken in the background the moment the page loads (or on first intent),
  and the ~1-minute wake becomes an **interactive loading screen** the visitor
  can read/play through — framed as a deliberate nod to console-era load
  screens, not an apology. This becomes a named state in Phases 3–4
  ("server-waking") and a build-plan item (static host + background wake ping
  + honest progress). Invite links must work from the static page too
  (Phase 3 question).

**Q4. Host-to-guest ROM sharing?**
Owner: *Has to be disabled for copyrighted games like SSB. In the future, if we
add games into our ecosystem that we can allow distribution for, we will.*

→ Decision: the public story is strictly **"bring your own ROM"**. The landing
  page never mentions transfer/sharing. Smash Remix is a patch on the SSB64
  ROM, so it falls under the same rule. Build-plan note (outside this page):
  the in-room "Share ROM with players" option must be disabled for the known
  copyrighted ROMs before launch, so the page and the product tell the same
  story.

#### Batch 2 (asked 2026-09-25) — feelings, story, audience confirmation

**Q1. Audience confirmation (competitive netcode scrutineers, HN/dev crowd)?**
Owner: *Yes, that could be a part of the audience.*
→ Secondary audience, served but not designed around: the page must survive
  their scrutiny (honest claims, the demo as proof) without turning into a
  tech demo for them.

**Q2. What should someone feel (arrival / first match / leaving)?**
Owner: *Locked-in, engaged, ready to have fun — similar to walking into an
arcade. The site should bring back similar feelings to arcades.*
→ Emotional target: **walking into an arcade.** Energy, focus, anticipation;
  you came here to play and everything around you says "go". The same feeling
  is wanted at all three moments; the owner did not split them. What
  specifically evokes "arcade" for the owner is asked in batch 3 (references),
  because it must be achieved *without* the pixel-art theme park (see Q3).

**Q3. What must it NOT feel like?**
Owner: *Pretty much all of these — a startup landing page, a sketchy ROM site,
an AI-generated product page, a retro-pixel-art theme park, a tech demo for
engineers, a 2005 forum. But also some shitty SaaS site or some AI slop site.*
→ Anti-references (all are hard "no"s):
  1. Startup / SaaS landing page (hero-benefits-testimonials-pricing rhythm,
     gradient blobs, feature grids with icons, "Get started" everywhere)
  2. Sketchy ROM site (download buttons, ads, mystery links, "free ROMs")
  3. AI-generated / AI-slop product page (generic copy, stock illustration,
     empty superlatives, uncanny consistency)
  4. Retro pixel-art theme park (8-bit fonts, CRT scanline filters, neon
     "INSERT COIN" everywhere as decoration)
  5. Tech demo for engineers (metrics-first, jargon in the hero)
  6. 2005 forum (dense links, badges, visitor counters)
  → **Design tension to solve in Phase 2:** "arcade feeling" (Q2) without
  "retro pixel-art theme park" (Q3). The arcade is a *feeling* (energy,
  people, ready to play), not a costume.

**Q4. The story.**
Owner: *Avoid calling attention to it being AI-assisted unnecessarily. No
need to add the personal story unless it makes sense. A call to Kaillera's
history would be cool. Point to the demo as proof people can investigate
themselves; a simple video explaining what rollback is and why it's more
advantageous than the traditional route would be cool. Friends list, lobbies,
voice, persistent identity, rankings all relate to my vision — the landing
page should not promise any of it until it's actually been delivered.*
→ Decisions:
  - **AI assistance is not mentioned on the page.** It stays in the About
    modal where it already is. Reason: it adds nothing for a player and
    pattern-matches to the AI-slop anti-reference.
  - **Personal story stays behind About** unless a single line earns its
    place in Phase 2 (e.g. one sentence of "why"). Default: off the page.
  - **Kaillera's history is on the page** — a short, visible "call" to it
    (the 2001 lineage), doubling as the "you are home" signal for veterans.
  - **Rollback: proof, not lecture.** The page points to `/demo.html` as
    self-verifiable proof, plus a short explainer video (what rollback is,
    why it beats lockstep), written under docs/launch-copy.md rules. Whether
    this is a segment of the intro video or a second video is a batch 3
    question.
  - **The community vision is a non-goal for the page.** No friends list,
    lobbies, voice, identity or rankings are promised or hinted until
    shipped. Only delivered features appear. (The real changelog is
    acceptable evidence of activity; a roadmap is not.)

#### Batch 3 (asked 2026-09-25) — references, the one action, video, name
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
| 2026-09-25 | Two co-primary audiences: newcomers seeking people/community, and Smash 64 / old-Kaillera veterans who must feel at home | Owner, batch 1 | 1 |
| 2026-09-25 | 60-second rule: what it is, what it does for you, how to start — no hype, "just play" always one action away | Owner: hype and false hope make people leave | 1 |
| 2026-09-25 | Landing page is static/always-up; server wake happens in the background behind an interactive, console-style loading screen | Owner: >1 min blank page is bad UX; loading screen as a callback | 1 |
| 2026-09-25 | Public story is strictly "bring your own ROM"; ROM sharing never mentioned; sharing to be disabled for copyrighted ROMs | Owner: no distribution of copyrighted games; only future redistributable games | 1 |
| 2026-09-25 | Emotional target: walking into an arcade (locked-in, engaged, ready to have fun) — achieved without pixel-art/CRT costume | Owner, batch 2; anti-references include "retro pixel-art theme park" | 1 |
| 2026-09-25 | Hard anti-references: startup/SaaS page, sketchy ROM site, AI-slop page, pixel-art theme park, engineer tech demo, 2005 forum | Owner, batch 2 | 1 |
| 2026-09-25 | No mention of AI assistance on the page; personal story stays behind About; Kaillera history is visible on the page | Owner: don't call attention to AI unnecessarily; history "would be cool" | 1 |
| 2026-09-25 | Rollback is shown as proof (demo + short explainer video), not taught in prose | Owner: demo people can investigate themselves | 1 |
| 2026-09-25 | Community vision (friends, lobbies, voice, identity, rankings) is a page non-goal until shipped | Owner: never promise what isn't delivered | 1 |
