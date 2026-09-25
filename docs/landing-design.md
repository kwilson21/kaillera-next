# Landing page design — kaillera-next

> **Status:** Phase 2 — direction A confirmed; live previews L1 at launch, hover-to-stream as first follow-up (§2.10). Seven plain questions open (§2.10). Player outreach in progress (Appendix A/B).
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

**Q1. What exactly is "arcade" for you?**
Owner: *All of those [sound and light at the door, attract-mode cabinets,
people around a good match, next-up coin, everyone's here to play, CSS
energy]. It's a feeling of community — joining and seeing moving parts,
interactions happening, but feeling like you are a part of it. Twitch streams
are the opposite of this; we want the opposite of that. You join and can
easily view other people's live matches and are allowed to spectate or join
them live if the owner allows; you hop into the game seamlessly. You can join
waiting rooms and chat with other people; you can easily see people's names,
profiles, records, playstyles, favourite character. Ideally in the future you
control an avatar and walk around, but that's just an idea.*
→ The arcade is **presence + permeability**: other people are visibly here,
  and you can walk over. Twitch is the anti-model because you watch from
  outside the glass. **Reality check (code, 2026-09-25):** rooms are joined by
  code/link only; `GET /list` exists server-side (room name, host, game,
  players x/max, status, password flag) but returns no join code and no page
  calls it; there is no chat, no profiles, no records; spectators need no ROM
  (host streams video to them); up to 20 spectators per room; late join and
  slot-claiming exist. → Gating question G1 below.

**Q2. References you love, and why.**
Owner: *Metal Gear Online (MGS4), Tekken 5 Dark Resurrection online, Call of
Duty 4 and Modern Warfare 2 on PS3, Halo 3 on Xbox 360 — this rolls the best
of those combined experiences up where possible. Old Kaillera was cool because
you could just join chat rooms and talk; half the time we weren't playing, we
were hanging out in a room with random people. Joining and leaving games at
will was fun; the atmosphere was inviting. The idea is to bring back that
inviting atmosphere.*
→ Reference family: **console-era online lobbies (2005–2010)** — a pre-game
  room with people in it, party-up, hop in/out, see who's here — plus
  Kaillera's chat-room culture. The design cue is *lobby*, not *storefront*
  and not *stream*.

**Q3. References you hate, and why.**
Owner: *Dragon Ball FighterZ and Street Fighter 6 — they do something similar
but microtransactions and constant money grabs ruin the idea. We're not
selling you anything, nor advertising characters or cosmetics to buy. All you
need is to own a copy of the game so you can legally obtain the ROM. If you
don't own the game you can still hop in, chat with people and spectate. I've
never played Club Penguin but I imagine it's like that.*
→ **Nothing for sale, nothing to unlock, nothing gated but the ROM you
  already own.** "Don't own it? You can still watch" is a real, shipped hook
  (spectators need no ROM) — the one honest thing the page can offer the
  ROM-less visitor today. (Chat is not shipped → not promised.)

**Q4. The one action the page must drive.**
Owner: *Each action is not necessarily the best, because you must own a ROM
to experience it, so we likely want the arcade experience. In the future I
may develop my own Smash 64-style fighting game that runs in the kaillera-next
environment.*
→ The one action is **"walk into the arcade"**: arrive, see what's happening,
  and then Play (have a ROM) or Watch (don't). Create/Join/Demo/Video are the
  cabinets, not the door. Future own game = redistributable, no ROM barrier —
  out of scope for this page.

**Q5. Video.**
Owner: *Separate videos. This is enough information that a separate YouTube
channel may be in the works; explaining how everything works is worth dev
vlogs or informational videos.*
→ Two videos: (a) intro — what it is, lobby → invite → friend joins → both
  screens; (b) rollback explainer — what it is, why it beats lockstep, under
  launch-copy rules. Lag visualizer link: not answered → small question S3.

**Q6. Name and address.**
Owner: *The name is kaillera-next; current domain kaillera-next.thesuperhuman.us;
it may get its own domain later if it's worth it.*
→ "kaillera" in the name carries the veteran signal; the page must not depend
  on the domain (it may change).

### Design Brief (v1 — for owner review)

**Product in one line.** Open a link, play Super Smash Bros. 64 or Smash Remix
online with friends in your browser. No install. Bring your own ROM.

**Audience.** Two co-primary groups, one secondary.
1. **Newcomers** who like an unserious, distinctive fighting game and want
   people to play with and a community to belong to. Have never used an
   emulator; may arrive on a phone with no ROM.
2. **Smash 64 veterans, especially old Kaillera players.** Must feel at home
   within seconds: the name, the lineage, the "just join a room" directness.
3. *Secondary, served not centred:* competitive players and developers who
   will scrutinise the netcode claims. Served by honesty and the demo.
Arrival modes for any of them: cold from a community post, from a friend's
invite link, or returning.

**Goals (in order).**
- G1 **Presence.** Within 60 seconds a visitor knows what this is, that
  people are (or can be) here, and how to walk in. The page is the arcade
  door, not a brochure.
- G2 **Permeability.** Play and Watch are both first-class and one action
  away. "No ROM? Watch." is real today and stated plainly.
- G3 **Home for veterans.** A visible call to Kaillera (2001) and its lineage.
- G4 **Honest proof of the netcode.** The demo and a short explainer video,
  under docs/launch-copy.md rules. Numbers only with sources.
- G5 **No dead air.** The sleeping server never shows a blank page: static
  landing, background wake, console-style loading screen.

**Emotional targets.** Walking into an arcade: locked-in, engaged, ready to
have fun. Moving parts, other people, and the sense you can join them. The
inviting atmosphere of Kaillera chat rooms and 2005–2010 console lobbies
(MGO, Tekken 5 DR, CoD4/MW2, Halo 3). On leaving: "I'll be back, and I'll
bring someone."

**Must not feel like.** A startup/SaaS landing page; a sketchy ROM site; an
AI-generated or AI-slop product page; a retro pixel-art/CRT theme park; a
tech demo for engineers; a 2005 forum; a Twitch stream (watching from outside
the glass); a fighting game's cash shop.

**Non-goals (for this page).**
- No promise or hint of unshipped features: friends list, lobbies with chat,
  voice, persistent identity, records, rankings, avatars.
- No ROM downloads, sharing, or hints where to get one. No legal hand-waving.
- No mention of AI assistance. Personal story stays behind About.
- Nothing for sale. No feature grids, testimonials, or "get started" rhythm.
- Not a general N64 site: three supported ROMs, said plainly.

**Constraints.** Static hosting with the API on a sleeping free tier (~1 min
wake); rollback needs HTTPS + cross-origin isolation; phones are first-class
(touch controls exist) but a phone-with-no-ROM visitor needs a Watch path;
launch-copy framing rules; name may outlive the domain.

**Success signals.**
- *Quantitative (page analytics, privacy-respecting):* share of first-time
  visitors who create, join or watch a room within 60 s; share of invite-link
  openers who reach "in game"; demo starts; return visits within 7 days.
- *Qualitative (Phase 6 tests):* a newcomer says what the site is in one
  sentence after 10 seconds; a veteran says "this is Kaillera" unprompted;
  nobody describes it as a startup, an AI page or a ROM site; no one asks
  "where do I download the game?" without finding the answer on the page.

**Gating questions (owner) — the brief cannot be final without these.**
- **G1. Does the arcade floor ship with the page?** The one action is
  "walk in and see what's happening", but today no page shows live rooms.
  Option A: scope a minimal *live rooms board* into the launch — host opts a
  room in as "open" (spectate / join), `GET /list` returns a join code for
  open rooms, page shows game · host · players x/4 · status · Watch/Join.
  Option B: design the page around today's product (create / join by link)
  and design the board as a state that appears once shipped. *My
  recommendation: A. Without it the page can only describe the arcade, not
  be it — and it forces us to design the honest empty state ("nobody's
  playing right now — start a room, share the link"), which is the most
  common state a new site is in.*
- **G2. Empty-state honesty.** May the page show a real aggregate number
  (e.g. "N matches played this week" from the server's session logs) so an
  empty board doesn't read as a dead site? Or no numbers at all?
- **G3. Ko-fi "Support" link.** Keep it quietly in the footer as today, or
  off the landing page entirely, given "we're not selling you anything"?

**Small questions (say "ok" or correct me).**
- S1. Password-protected rooms exist; on the board they'd show a lock and
  not be joinable. Fine?
- S2. The two videos are hosted on YouTube and embedded (not self-hosted).
- S3. The lag visualizer gets a secondary link under the rollback section,
  the demo gets the primary one.

**Ask real people (before Phase 3 if possible).** Two or three old Kaillera
players and one or two newcomers. Scripts are in Appendix A; answers go in
Appendix B verbatim.

### Brief review — owner answers (2026-09-25)

- **G1 → Option A, small scope.** Owner: *"Option A seems reasonable, we just
  want to keep the scope small since there's no guarantee anyone would
  actually use this."* Minimal scope, so it can't grow:
  1. Host has one checkbox in the pre-game overlay: **"List this room on the
     front page"**. Password-protected rooms are never listed. (Default value
     is a Phase 3 question: default-on gives presence, default-off gives an
     always-empty board.)
  2. `GET /list` gains the room code for listed rooms only; unlisted rooms
     keep today's behaviour (no code).
  3. The landing page renders: game · host name · players x/max · status
     (waiting / in game) · **Watch** · **Join** (Join only while a slot is
     open; Watch while spectator slots are open). Nothing else: no chat, no
     profiles, no sorting, no filters.
  4. The board's empty state is designed as carefully as the full one.
- **G2 → Real numbers allowed.** Owner: *"Sure, we can show real numbers."*
  Candidates (Phase 2 picks): matches played this week / rooms opened this
  week from session logs; "last match N minutes ago". Never a fake or padded
  number; if the number is embarrassing, show it anyway or show none.
- **G3 → Ko-fi stays.** Owner: *"The footer is quiet enough that it's not
  distracting."* Keep as today: footer, text link, no callout.
- **S1–S3** not answered → treated as provisional "ok" (locked rooms shown
  with a lock and not joinable; videos on YouTube, embedded; demo primary,
  lag visualizer secondary). Owner can correct at any time.

**Brief status: v1 accepted with G1–G3 resolved.** Phase 2 may begin; real-
player answers (Appendix B) are folded in as they arrive.

---

## 2. Phase 2 — Experience and content (v1, for owner review)

Everything here follows the brief: the page is the arcade door; the one action
is walk in, see what's happening, then Play or Watch; nothing promised that
isn't shipped; docs/launch-copy.md rules on every netcode sentence.

### 2.1 The narrative, top to bottom

One page, six beats. Desktop and phone share the order; the phone differences
are called out per beat. Sections are short: a newcomer reaches "how to start"
without scrolling, and a veteran can leave the page inside ten seconds by
clicking Create.

| # | Beat | What they see | What they read | What they do | Brief goal |
|---|---|---|---|---|---|
| 1 | **The door** | Name, one line, and the *Open rooms* board directly beneath, with Create / Join / Watch | What it is, who's here, what you need | Create a room · Watch or Join an open one · enter a code | G1 Presence, G2 Permeability |
| 2 | **You bring the game** | A short plain-text block, no imagery | Bring your own ROM; never uploaded; the three supported ROMs; watching needs none | Nothing, or click Watch | Honesty, G2 |
| 3 | **How it works** | The intro video (click-to-play) with a three-line caption | Create → send link → everyone drops their ROM → Start. Up to 4 players, spectators welcome, phones OK | Watch 50 s, or skip | Newcomer clarity |
| 4 | **Why it feels close to the couch** | Two proof buttons and the explainer video | Rollback explained in four sentences under the framing rules | Try the demo (ROM) · Lag visualizer (no ROM) | G4 Proof |
| 5 | **Since 2001** | One paragraph and the lineage ribbon | Kaillera's history and that this continues it; free, open source | Click GitHub or About | G3 Home for veterans |
| 6 | **Footer** | As today, quiet | Credit, GitHub, Support, About, version, and the ROM disclaimer | — | Non-goals |

**Beat 1 in detail — the door.** The hero has no marketing image. The board
*is* the hero: it's the moving part that makes the page a place rather than a
brochure. Three states, all designed with equal care (Phase 4 wireframes):

- *Live (server awake, rooms listed):* header "Open rooms · N people playing
  right now"; one row per listed room: game · host · players x/4 · status
  (waiting / in game, N min) · **Watch** · **Join** (Join only while a slot is
  open). Rows update live (polling `GET /list`, every ~10 s). Below the board:
  **Create a room** (primary), and a small "Have a code?" input with Join /
  Watch.
- *Empty (server awake, nothing listed):* the board area says so plainly, gives
  the real weekly number (G2), and hands you the next move: create one and send
  the link. This is the most common state for a new site; it must feel like an
  arcade at opening time, not a closed one.
- *Waking (server asleep, first visit after idle):* the board area becomes the
  **loading screen**. Honest line about the nap, a real progress cue, and
  something to do: the input-lag visualizer (already built, pure static JS,
  works on tap) runs *inside* the board area. You're pressing a button and
  feeling rollback vs lockstep while the machine powers on. That's the
  console-era loading screen callback, and it's on-topic. Create / Join / Watch
  are shown but disabled with "ready in a moment" until the server answers.
  Wake is triggered on page load (the board needs the server anyway); every
  visit also resets the idle timer.

**Phone (beat 1).** Name and line, then the board (rows become cards: game,
host, x/4, status, one Watch/Join button), then a full-width **Create a room**.
"Have a code?" collapses to a link that opens the input. The waking state uses
"tap" instead of "press SPACE". The one-line ROM note sits under Create so a
phone visitor with no ROM immediately sees Watch is for them.

**Name field.** Today the lobby asks for your name before Create. Proposal:
drop it from the landing page; the room's pre-game overlay already has a name
input and remembers it. One fewer field between the door and the floor
(question Q2 below).

**Beat 3 — how it works.** This is where SaaS creeps in (three icons in a
grid). Instead: the video is the cabinet's attract mode, and the caption is
three short lines of plain text under it, no icons. Click-to-play thumbnail on
every device; no autoplay (autoplay hero video is an AI-page tell and costs
data on phones).

**Beat 4 — proof.** Two buttons, clearly labelled by what they need: "Try the
demo (needs your ROM)" and "Lag visualizer (no ROM)". The explainer video
sits beside them. Numbers only with sources; the ~150 ms threshold is the one
number we cite.

**Beat 5 — since 2001.** For veterans this is the "you're home" signal. Short
paragraph plus a single-line lineage ribbon (the same list as the About modal)
so the names are on the page without becoming a wall. Ends with "free, open
source, GPL-2 · GitHub".

**Not on the page (by decision).** ROM sharing, chat, profiles, records,
rankings, avatars, roadmap, AI assistance, the personal story (About link
only), pricing of any kind, feature grids, testimonials, download buttons.

### 2.2 Draft copy (v1)

Voice: plain, second person, short sentences, no exclamation marks, no
superlatives. Sentence case (the brand name stays lowercase). Every netcode
line checked against docs/launch-copy.md.

**Beat 1 — the door**

> # kaillera-next
> Super Smash Bros. 64 online with friends. In your browser. No install.
>
> **Open rooms** · 3 people playing right now
> | Smash Remix 2.0.1 | hosted by Kaz | 2/4 | waiting for players | Watch · Join |
> | Super Smash Bros. | hosted by Moose | 4/4 | in game · 6 min | Watch |
>
> [ Create a room ]
> Have a code? [________] Join · Watch
>
> Playing needs your own SSB64 or Smash Remix ROM. Watching doesn't.

*Empty state:*

> **Open rooms** · nobody's in a room right now
> 41 matches were played this week. Open a room and send the link — the first
> one in picks the stage.
> [ Create a room ]

*Waking state:*

> **Powering on…**
> The room server naps when nobody's around. Your visit woke it up; it takes
> up to a minute. Press SPACE (tap on a phone) while you wait — this is what
> rollback does to lag.
> [ input-lag visualizer, inline ]
> Create · Join · Watch — ready in a moment.

*If the wake takes longer than expected (Phase 3 sets the deadline):*

> Still powering on. If this takes more than a couple of minutes, something's
> wrong on our side — reload, or come back in a bit.

**Beat 2 — you bring the game**

> ## You bring the game
> kaillera-next doesn't host, share or link to ROMs. You drop your own copy of
> Super Smash Bros. 64 onto the page. It's read in your browser and never
> uploaded anywhere.
>
> Works right now: Super Smash Bros. (US) · Smash Remix 2.0.0 (US) · Smash
> Remix 2.0.1 (US). Files: .z64, .n64, .v64 or .zip. Smash Remix is a free
> community mod you apply to your own SSB64 copy.
>
> No ROM? You can still watch any open room.

**Beat 3 — how it works**

> ## How it works
> [ intro video, 50 s ]
> Create a room and send the link. Friends open it on a laptop or a phone.
> Everyone drops their own ROM, the host presses Start.
> Up to 4 players. Spectators welcome. Keyboard, gamepad or on-screen controls.

**Beat 4 — why it feels close to the couch**

> ## Why it feels close to the couch
> Rollback netplay runs the game at full speed on your machine and predicts
> what your opponent pressed. When a prediction misses, it rewinds a few
> frames and replays, quietly. The network lag is still there; rollback hides
> it from you. Under about 150 ms of round trip, it feels like playing
> offline. Lockstep, the old way, waits the full round trip on every frame.
>
> Don't take our word for it.
> [ Try the demo — needs your ROM ]  [ Lag visualizer — no ROM ]
> [ explainer video, 60 s ]

Checked: "hides", not "fixes"; no "zero lag"; no "no input delay"; the 150 ms
figure is the sourced one; "rewinds… quietly" describes the mechanism without
calling rollbacks a failure.

**Beat 5 — since 2001**

> ## Since 2001
> Kaillera, by Christophe Thibault, let a generation play N64 online. A dozen
> servers and clients carried it for twenty years. kaillera-next is the same
> idea with nothing to install and rollback netcode.
> Kaillera → EmuLinker → EmuLinker SF → SupraClient → n02 → Project64k →
> AQZ NetPlay → Ownasaurus Client → EmuLinker X → EmuLinker-K → Kaillera Reborn
> → kaillera-next
> Free and open source (GPL-2). [GitHub]

**Beat 6 — footer**

> by Kazon Wilson (Agent 21) · Inspired by Kaillera by Christophe Thibault
> GitHub · Support · About · v0.53.0
> kaillera-next does not host, distribute or link to ROMs.

### 2.3 "You need your own ROM" — honest, low-friction, no gray areas

- **Say it twice, plainly.** One line under Create (beat 1) so nobody starts
  a room and hits a wall; one short block (beat 2) with the specifics.
- **Say what happens to the file.** "Read in your browser, never uploaded."
  True (IndexedDB cache) and it answers the newcomer's fear.
- **Say exactly which three ROMs** and the formats. The current lobby already
  does; keep it.
- **Never** link to ROM sites, explain dumping, or say "find it online". The
  page says "your own copy" and stops. (Q3 asks whether one link to the
  official Smash Remix project, which distributes patches only, is allowed.)
- **Give the ROM-less visitor a real path:** Watch. It's shipped, needs no
  file, and it's the arcade behaviour (stand behind the cabinet).
- **In-room states** (wrong ROM, unsupported ROM, friend has no ROM) are
  Phase 3 flows; the landing page's job is only that nobody is surprised.

### 2.4 Video scripts — first cut for TTS narration

Both under 60 s, both narrated in the same plain voice as the page. Screen
recordings only; no Nintendo assets outside what the emulator itself renders
in the recording (Q6 asks whether even that is acceptable in a public video).

**Video 1 — Intro (≈50 s)**

```
[0:00] landing page, cursor on Create
       "This is kaillera-next. Super Smash Bros. 64, online, in your browser."
[0:05] click Create → room page, invite link visible
       "Create a room. You get a link."
[0:10] link pasted into a chat
       "Send it to a friend."
[0:14] friend opens it on a phone, lands in the room
       "They open it. Nothing to install, on a laptop or a phone."
[0:20] both drop a ROM file onto the page
       "Everyone drops their own copy of the ROM. It stays on your device."
[0:28] host presses Start; split screen, both devices boot into the game
       "Press Start. Both screens run the same game at the same time."
[0:38] a few seconds of play, side by side
       "Underneath it's rollback netplay, so it feels close to playing on
        the same couch. The next video shows why."
[0:47] URL on screen
       "Free. No account. kaillera-next."
```

**Video 2 — Rollback explained (≈60 s)**

```
[0:00] two devices, a line between them
       "Every online game has the same problem: your opponent's button press
        takes time to reach you."
[0:08] lockstep diagram: each frame waits for the far input
       "The old way, lockstep, waits for it. Every frame. So every press you
        make shows up late, by the whole round trip."
[0:18] rollback diagram: local game runs, prediction, then a short rewind
       "Rollback doesn't wait. It runs your game at full speed and predicts
        what your opponent did. If the real input matches, nothing happens.
        If it doesn't, the game quietly rewinds a few frames and replays
        with the correct input."
[0:35] "The lag is still on the wire. Rollback hides it from you. Under about
        150 milliseconds of round trip, it feels like playing offline."
[0:45] demo page: lag slider to 200, rollback toggled off, game stalls;
       toggled on, smooth
       "Don't take my word for it. The demo lets you drop a ROM, set the lag
        and switch rollback off and on. Same game, same opponent. Feel the
        difference."
[0:58] URL
```

Both scripts checked against the framing rules: hides, not fixes; round-trip
language; no "zero lag"; rollbacks described as the mechanism.

### 2.5 Three directions

All three share the same narrative and copy. They differ in what "arcade"
means visually. None uses pixel fonts, CRT scanlines, neon "INSERT COIN", or
any Nintendo asset. The one visual system they all share: the four player
colours (P1 red, P2 blue, P3 yellow, P4 green), an N64-era convention, not
anyone's IP, used for player slots on the board and in the room.

**Direction A — The Lobby** *(console-era online lobby, 2005–2010)*
- *Mood:* the pre-game lobby in Halo 3 or MGO. Dark, composed, slightly
  military-grade. A list of people, a status per row, one glowing "ready"
  colour. Quiet confidence; nothing is trying to sell you anything.
- *Hero:* the board fills the first screen like a lobby roster. Name top-left
  in a condensed face, one line under it, Create as the single bright button.
- *Colour:* charcoal to deep navy background, off-white text, one accent
  (electric blue or the current #6af) for ready/live states, player colours
  only in slot markers.
- *Type:* condensed grotesk for headings (Barlow Condensed or Saira Condensed
  feel), a plain humanist sans for body. Tabular numerals on the board.
- *Motion:* rows slide in as rooms appear; the live dot breathes; nothing else.
- *Why it's arcade:* presence. A roster of people right now, and a "ready"
  state you can walk into.
- *Trade-offs:* strongest "home" signal for veterans of that console era;
  cheapest to build (no illustration); coldest for newcomers; with zero rooms
  it's the emptiest of the three; easiest to slide into "engineer tech demo"
  if the type gets too technical.

**Direction B — The Floor** *(the arcade as a place: light, warmth, cabinets)*
- *Mood:* the moment you walk through the door: a dark room lit by screens,
  marquee light on the ceiling, sound you can almost hear. Rooms are cabinets
  in a row; each shows its attract-mode status. Warm, saturated, alive.
- *Hero:* the board rendered as a row of cabinet cards, each lit in its own
  player-colour glow when live and dim when waiting. The name sits above like
  a marquee, in a wide, bold display face (marquee lettering, not 8-bit).
- *Colour:* near-black with warm light: amber, red and cyan glows at low
  saturation on surfaces, cream text. Backgrounds could be a single
  photographic/illustrated "floor" that is dark enough to never fight the UI.
- *Type:* wide geometric display for the name and section titles, neutral
  sans for everything else.
- *Motion:* cabinet cards glow up when a room goes live; the waking-state
  visualizer pulses in the same light. Restrained; light does the work.
- *Why it's arcade:* literally. The light and the row of machines.
- *Trade-offs:* biggest emotional hit and the furthest from SaaS; strongest
  at the empty state (a lit, quiet arcade still feels like a place); highest
  cost (an illustrated floor, more art direction in Phase 5); highest risk of
  tipping into theme park if the decoration grows; needs care on cheap phones
  (glows and large images cost battery and bandwidth).

**Direction C — The Clubhouse** *(Kaillera chat-room warmth; hand-made)*
- *Mood:* a friend's basement with a couch and a console, or the Kaillera
  chat room where half the night was talking. Friendly, low-key, unpolished
  on purpose. The opposite of a product page because it looks like a person
  made it.
- *Hero:* a plain, warm surface; the board is a simple list with names in
  big type; Create is a big friendly button. Hand-drawn or flat-vector
  touches (a cabinet outline, a controller) in the four player colours.
- *Colour:* warm dark (deep brown-grey) or, riskier, a cream background
  with bold flat player colours. Light backgrounds fight the black game
  canvas on the next page, so dark-warm is the safer version.
- *Type:* a friendly humanist sans with some character (Nunito-like, not
  Comic Sans), generous size.
- *Motion:* almost none. Stillness is part of the friendliness.
- *Why it's arcade:* the people, not the machines. It reads "come hang out".
- *Trade-offs:* most welcoming to newcomers and most convincingly not-AI;
  weakest "locked-in" energy; veterans who loved MGO/Halo lobbies may find it
  soft; the least differentiated visually (many indie sites look like this).

**Recommendation.** A mix: **B's door on A's floor.** The name, the first
screen and the waking state carry B's warmth and light (that's where the
arcade feeling is made or lost); the board rows, the copy blocks and the
proof section use A's composure so it stays readable and cheap on phones.
C's lesson is kept as a rule: never look machine-made. Phase 4 wireframes
would follow this mix unless you pick otherwise.

### 2.6 Questions for the owner (Phase 2 gate)

- **Q1. Direction:** A, B, C, or the recommended mix? If mix, anything from C
  you'd carry over?
- **Q2. Name field:** drop it from the landing page and let the room ask?
  (Fewer steps at the door; costs nothing for returning players since the
  room remembers the name.)
- **Q3. Smash Remix link:** may the page link once to the official Smash
  Remix project page (it distributes patches, not ROMs)? Without it,
  "a free community mod you apply to your own copy" is the whole sentence.
- **Q4. Weekly number:** "N matches this week" (from session logs) as the
  single real number on the page, shown in the header and the empty state,
  and nothing else. OK, or would you rather "rooms opened" or "last match N
  min ago"?
- **Q5. Wake on load:** the board needs the server awake, so every landing
  visit pings it. Fine on the free tier's terms?
- **Q6. Video footage:** the intro and explainer videos will show the game
  running on screen (it's a recording of the product). Acceptable for public
  videos, or do you want the recordings cropped/blurred to UI only?
- **Q7. Phone claim:** "Keyboard, gamepad or on-screen controls" — has a
  Bluetooth controller been tested on a phone? If not, I'll write "on-screen
  controls" only.
- **Q8. Copy tone:** the drafts are sentence case, plain, no exclamation
  marks. Your own messages are lowercase-casual. Keep sentence case for the
  page, or go lowercase throughout to match the name?

**What only real players can answer (log in Appendix B when it arrives):**
whether the "Since 2001" paragraph lands (show it to one vet and ask "what
does this make you feel?"); whether "You bring the game" is clear to a
newcomer (ask "what would you need before you could play?").

### 2.7 Seeing the directions before choosing (added 2026-09-25)

Owner: *"I'd have to see images of the design before picking a direction."*
Two ways to see them, both design artifacts, neither product code, neither in
the repo:

**1. Live mockup (private, opens on desktop and phone):**
https://claude.ai/artifact/9pPt7Vtvxtxjs5csq7ErM3
Same draft copy in all four (A Lobby, B Floor, C Clubhouse, Mix), with the
board's Live / Empty / Waking states. The Waking state has a working copy of
the input-lag visualizer (press SPACE or tap) so the loading-screen idea can
be felt, not imagined. Fake rooms and numbers; no game footage; no
illustration (B's floor art would come from Phase 5 prompts).
Deep links: `#A` `#B` `#C` `#M`.

**2. GPT image prompts — direction exploration (hero, desktop).** These are
atmosphere shots to choose *by*, not final assets (final prompts come in
Phase 5 after wireframes). Image models garble text: judge mood, light,
type feel and layout, not the words. Paste one prompt per run; make the
three variations by swapping the bracketed line.

*Shared rules for every prompt below (paste verbatim at the end of each):*

> UI mockup, flat, no device frame, no browser chrome, no hands, no people's
> faces. Dark interface. No pixel-art fonts, no CRT scanlines, no "insert
> coin" text, no neon signage clichés. No Nintendo characters, logos, game
> screenshots or recognisable game art; evoke the era with light, materials
> and layout only. Text can be approximate. Aspect ratio 16:10, 1600×1000.

**Prompt A — The Lobby**

> Landing page hero for a browser-based retro-console netplay site, in the
> visual language of a 2007 console online pre-game lobby (think a
> military-clean roster screen). Layout, top to bottom: site name
> "kaillera-next" top-left in a tall condensed sans, uppercase, one line
> under it "Super Smash Bros. 64 online with friends. In your browser. No
> install." Below that, a full-width roster panel titled "OPEN ROOMS" with
> three rows: game name, host name, four small square slot markers in red /
> blue / yellow / green, "2/4", status text, and two small buttons "Watch"
> and "Join" at the right. Under the panel a single bright button "Create a
> room" and a small "Have a code?" field. Palette: charcoal-navy background
> (#0e1218), off-white text, one electric-blue accent (#5aa8ff) for the live
> status dot and the primary button, nothing else coloured except the slot
> markers. Mood: composed, quiet confidence, a place where people are
> present; not a dashboard, not a SaaS page. Typography feel: condensed
> grotesk headings, tabular numbers, plain humanist body text.
> [Variation 1: as described. Variation 2: the roster panel fills the whole
> first screen edge to edge, name reduced to a small header. Variation 3:
> add a faint horizontal scanning highlight across the live row only, no
> other motion cues.]
> + shared rules

**Prompt B — The Floor**

> Landing page hero for a browser-based retro-console netplay site that
> feels like walking into an arcade at night: a dark room lit from above by
> warm marquee light, screens glowing in a row. Layout, top to bottom: site
> name "kaillera-next" centred-left in a wide, heavy geometric display face
> with a soft amber glow around the letters; one line under it "Super Smash
> Bros. 64 online with friends. In your browser. No install." Below, three
> upright "cabinet" cards side by side, each with a small dark status strip
> on top ("WAITING FOR PLAYERS" or "IN GAME · 6 MIN"), a game name, a host
> name, four small slot markers in red / blue / yellow / green, and Watch /
> Join buttons; the middle card is live and glows softly in red light, the
> others sit dim. Under the cards, one amber button "Create a room". Behind
> everything, a very dark illustrated arcade floor: suggestion of more
> cabinets receding, reflections on a dark floor, warm amber and cool cyan
> light spill, all at low contrast so the UI stays readable. Palette: warm
> near-black (#0b0908), cream text (#f3e9d8), amber accent (#ffb347), red and
> cyan light only as glow. Mood: energy, anticipation, other people are here,
> you can walk over. Typography feel: wide bold display for the name, plain
> sans for everything else.
> [Variation 1: as described. Variation 2: no illustrated floor, only the
> light: a single warm radial glow at the top edge and the cabinet glows.
> Variation 3: cabinets shown as a horizontal strip along the bottom of the
> hero like a row of machines seen from the door, name and line above them
> in the dark.]
> + shared rules

**Prompt C — The Clubhouse**

> Landing page hero for a browser-based retro-console netplay site that
> feels like a friend's basement game room or an early-2000s chat room:
> friendly, hand-made, unpolished on purpose. Layout, top to bottom: site
> name "kaillera-next" in a rounded, heavy, friendly sans (not childish),
> one line under it "Super Smash Bros. 64 online with friends. In your
> browser. No install." Below, a simple list panel with rounded corners
> titled "Open rooms" and three rows: game name in large text, host name,
> four flat round slot markers in red / blue / yellow / green, "2/4", and a
> big rounded "Join" button. A large rounded amber button "Create a room"
> underneath. Small flat-vector touches in the four player colours: a
> controller outline, a cabinet outline, a couch; drawn simply, like
> stickers, in the corners, not dominating. Palette: deep warm brown-grey
> background (#1f1a17), warm off-white text, amber accent (#f2a93b), flat
> player colours. Mood: come hang out; a person made this; nothing is being
> sold. Typography feel: rounded humanist sans throughout, generous sizes.
> [Variation 1: as described. Variation 2: cream/paper background (#f4efe4)
> with dark text and the same flat colours, to test a light version.
> Variation 3: remove all illustration; friendliness carried by type, radius
> and colour alone.]
> + shared rules

**Prompt M — Mix (B's door on A's floor)**

> Landing page hero for a browser-based retro-console netplay site. The top
> of the page is lit like an arcade door at night: a single warm amber
> radial glow from the top edge on a warm near-black background, the site
> name "kaillera-next" in a wide, heavy geometric display face with a soft
> amber glow, one line under it "Super Smash Bros. 64 online with friends.
> In your browser. No install." Below the light, the page becomes composed
> and quiet: a full-width roster panel titled "OPEN ROOMS" with three rows
> (game, host, four small square slot markers in red / blue / yellow /
> green, "2/4", status, Watch / Join buttons), thin dividers, tabular
> numbers, condensed uppercase labels; one live row marked with a small
> amber dot. Under it, one amber button "Create a room" and a small "Have a
> code?" field. Palette: near-black (#0d0c0b), warm off-white text, amber
> (#ffb347) as the only accent. Mood: warmth at the door, calm on the floor.
> Typography feel: wide display for the name only, condensed labels, plain
> humanist body.
> [Variation 1: as described. Variation 2: glow shifted to cool cyan with
> amber only on the button. Variation 3: the roster rendered as low, wide
> cabinet cards in one row instead of table rows.]
> + shared rules

**What to look for when comparing (mockup or images), against the brief:**
1. *Ten-second test:* cover the copy with your hand. Does it still feel like
   a place with people in it (arcade, lobby) or like a product page?
2. *Anti-reference check:* does anything read as SaaS, ROM site, AI page,
   theme park, engineer demo, or forum? Name the element, not the vibe.
3. *Empty state:* switch the board to Empty. Does the direction survive
   with nobody home? (This is the state most visitors will meet at first.)
4. *Waking state:* is the loading screen something you'd stay on for a
   minute, or does it feel like an error?
5. *Phone:* open the mockup on your phone. Is Create one thumb away? Does
   Watch read as "for me" to someone with no ROM?
6. *Veteran signal:* does the name treatment feel like a place you'd
   already know, or like a new brand?
7. *Cost:* which elements would need real art (Phase 5) versus CSS alone?

_Owner's first reaction to the mockup (2026-09-25): "A looks great."_

**GPT images, reviewed (2026-09-25).** Owner ran Prompt A three times and
*"didn't care for the GPT generated images."* Looking at them against the
brief: the layout of A translated fine, but every image invented content:
Mario Kart 64 and GoldenEye rooms, "Stock 4 / Final Destination" modes,
taglines like "same games, more friends, further together" and "good games
travel far". That is the AI-slop anti-reference made visible. Two decisions
follow:
- **Direction A is the direction** (owner to confirm in one word).
- **No generated imagery on the page.** Real product screenshots and real
  game frames instead. Phase 5 changes from "GPT prompts" to a **shot list**
  of real captures (Q10 below).

### 2.8 Live previews: Twitch, but you can walk in (added 2026-09-25)

Owner: *"What could improve this is actual screenshots and playing a stream of
the game. Similar to when you go to Twitch or YouTube, it invites you to join
in, but you'll actually be able to join in instead of watching someone else
without being able to interact with them."*

This is the arcade floor made literal: the cabinet's attract mode. The mockup
now has a **Live previews** toggle (default on): a featured "Now playing"
match with a frame, **Watch** and **Join · 1 slot open**, and a small frame
per room row. Frame boxes are placeholders; no game imagery is included.
https://claude.ai/artifact/9pPt7Vtvxtxjs5csq7ErM3

**What is already shipped that this stands on**
- Spectators receive the host's canvas as video over WebRTC; no ROM needed;
  up to 20 per room (`MAX_SPECTATORS`).
- Late join mid-game: a joiner takes an open slot and syncs state (needs
  their own ROM). Spectators can claim a vacated slot (`claim-slot`).
- A `game-screenshot` Socket.IO event already posts periodic gameplay
  screenshots (matchId, slot, frame, data) to the server in debug mode, and
  the admin API stores and serves them. The plumbing for "a frame every few
  seconds" exists; it needs a non-debug, listed-rooms-only variant.

**Three levels of "live", smallest first**

| Level | What the visitor sees | What it costs | Verdict |
|---|---|---|---|
| **L1 Frames** | A real frame per listed room, refreshed every ~10 s; the newest in-game room is the featured panel. Click **Watch** → the room's existing spectator view; **Join** when a slot is open. | Host of a listed room uploads one small JPEG (~320×240, 10–20 KB) every ~10 s. Server keeps only the latest frame per room in memory, drops it when the room closes. `GET /list` adds a frame URL + age. Stale >30 s dims. | **Recommended for launch.** Small, honest, and it is already "Twitch but you can walk in": the frame invites, Watch drops you in, Join takes the slot. |
| **L2 Featured stream** | The featured panel plays real video in place when clicked (not autoplay), by connecting the visitor as a spectator to that room from the landing page. | A spectator slot and the host's upload bandwidth per viewer; counts against the 20 cap; signaling round-trip. | Polish for later, only if L1 shows people click Watch. |
| **L3 Autoplay streams for every room** | Every row is live video. | Host upload × every landing visitor; spectator caps; consent. | Rejected. |

**Consent and privacy.** Frames come from the emulator canvas only, never the
host's screen. The host's listing checkbox must say what it does: *"List this
room on the front page (shows a live preview)"*. Player names are visible on
the board, as they already are in the room.

**Empty state with previews.** No in-game rooms → no featured panel; the
board shows the empty state. A *recorded* clip as attract mode when nothing
is live would need a clear "recorded" label, or it fakes presence (Q11).

**"How it works" with real screenshots.** The intro video stays click-to-play,
but the first thing seen in beat 3 becomes three real screenshots: the room
page with the invite link, a phone joining, both screens playing.

**Intellectual property, said plainly.** Live frames and streams of a game a
player owns are the same category as Twitch and YouTube streams of that game:
widespread and tolerated, not risk-free. Static screenshots of the game used
to promote the site are a step further. Neither is ROM distribution, and the
"no ROMs hosted" line stays true. I am not a lawyer; this is the owner's call
(Q9), and the Phase 5 rule "no Nintendo IP" stays for any generated art.

### 2.9 Open questions after the owner's image review

- **Q1 (revised). Direction A: confirmed?** One word.
- **Q9. Game imagery on the page.** (a) live frames from listed rooms (L1),
  (b) real screenshots in "How it works", (c) both, (d) neither. If (d), the
  board shows names and status only and "How it works" uses UI-only crops.
- **Q10. Phase 5 becomes a shot list** of real captures (which screens, which
  moments, what to hide), with no generated images. OK?
- **Q11. Attract mode when nothing is live:** a recorded clip labelled
  "recorded", or nothing (empty state only)? Recommendation: nothing at
  launch; honesty first.
- **Still open from §2.6:** restated plainly in §2.10.

### 2.10 Owner's answers (2026-09-25) and the hover-to-stream assessment

- **Direction A: confirmed.** ("Yes.")
- **Game imagery: both** live frames on the board and real screenshots in
  "How it works". Owner's goal: *"the screenshot, to mouse-hover that
  automatically starts the stream, would be the goal, but only if it's not
  too crazy to implement."*
- **Phase 5 is a shot list** of real captures. ("Ok.")
- **Nothing live → empty state only.** No recorded attract clip.

**Hover-to-stream, assessed against the code.** Today a spectator opens the
room page with `spectate=1`; the host starts a canvas video stream lazily
when that spectator connects (`startSpectatorStream`, netplay-rollback.js),
and the spectator receives it via WebRTC `ontrack` into a `<video>`. So
hover-to-stream on the landing page is: a *receive-only* version of that
path, embedded in the static page, started by hover. No emulator, no ROM, no
SharedArrayBuffer needed on the visitor's side.

Not crazy, not free. Verdict: **medium, roughly a few days of build**, with
these rules to keep it sane:
1. **Featured panel only.** Rows keep the 10-second frame (L1). One hover
   target per page means at most one preview connection per visitor.
2. **Frame is the poster; video replaces it.** Hover starts after ~500 ms,
   the connection lingers ~20 s after the mouse leaves, so a wandering cursor
   doesn't churn the host with connect/disconnect.
3. **Phones have no hover:** tap = Watch (opens the room as a spectator).
4. **Preview spectators count against the room's 20-spectator cap** and are
   marked `preview` so the room's list can show them as "peeking" or hide
   them (small server change; decide in Phase 3).
5. **Ship L1 first, hover-stream as the first follow-up.** The panel is
   designed for both from day one; the video layer is added when L1 is live
   and people demonstrably click Watch. Reason: host upload bandwidth is the
   one cost nobody on the page pays but the host, and L1 proves demand before
   spending it.

**The remaining questions, asked plainly** (a recommended default on each;
"defaults" accepts all):
- **Name box.** The front page currently asks for your name before "Create a
  room". Should the front page stop asking and let the room ask instead? The
  room already has a name box and remembers it. *Default: yes, stop asking
  on the front page.*
- **Smash Remix link.** May the page link to the official Smash Remix site?
  It publishes patches you apply to your own ROM, not ROMs. *Default: yes,
  one link, in "You bring the game".*
- **The one number.** Which real number goes on the board header and the
  empty state: "N matches this week", "N rooms opened this week", or "last
  match N minutes ago"? *Default: matches this week.*
- **Waking the server.** Every visit to the front page will wake the
  sleeping server, because the board needs it. Fine? *Default: yes.*
- **Phone controllers.** Have you tested a Bluetooth controller on a phone
  with the site? If not, the page claims on-screen controls only. *Default:
  claim on-screen only until tested.*
- **Tone.** Page copy in sentence case ("Create a room") or all lowercase
  like the name ("create a room")? *Default: sentence case.*
- **Game footage in the two videos.** Same answer as the imagery decision,
  so the videos show the game running? *Default: yes.*


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

## Appendix A — Research scripts (send as written)

Rules for the sender: don't describe the project, don't send the link, don't
ask "would you use…", don't ask leading questions ("wasn't the lag awful?").
Allowed follow-ups only: "what do you mean?" and "can you give me an example?"
If they ask why: *"working on something, I'll show you when it's real — didn't
want to colour your answers."* Copy answers verbatim into Appendix B.

### A1. Old Kaillera players — direct message (one person at a time)

> hey — random one. been thinking about the old Kaillera days lately (SSB64,
> the servers, all of that). got a few minutes for 3 questions? no wrong
> answers, I just want your honest memory of it.
>
> 1. what do you actually remember liking about playing on Kaillera?
> 2. what was the worst part?
> 3. if you can, walk me through a typical night on there — from opening the
>    client to logging off.
>
> (and if you still play 64 online anywhere these days — where?)

### A2. Old Kaillera players — group / Discord post

> quick one for anyone who played SSB64 on Kaillera back in the day. I'm
> trying to remember what it was actually like, not the nostalgia version.
> reply here or DM me, whichever:
>
> 1. what did you like about playing on Kaillera?
> 2. what was the worst part?
> 3. what did a typical night on there look like, start to finish?
>
> no wrong answers. thanks.

### A3. Newcomers — 10-second baseline (optional, 1–2 people)

Show them the current lobby (kaillera-next.thesuperhuman.us) for about ten
seconds, on their own phone if possible, then take it away and ask:

> 1. what do you think this is?
> 2. what would you do first?
> 3. is there anything you'd need before you could use it?

Don't correct them. Their wrong answers are the data.

### What to record for each person

- handle or initials · roughly which years they played · how (Project64k,
  Mupen, other) · desktop or phone today
- their answers **verbatim** (paste, don't paraphrase)
- anything they said unprompted after the questions

## Appendix B — What real people said
_Empty until answers arrive. Verbatim, one block per person._

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
| 2026-09-25 | The one action is "walk into the arcade": arrive, see what's happening, then Play or Watch | Owner, batch 3: no single CTA wins because a ROM is required to play | 1 |
| 2026-09-25 | Arcade = presence + permeability; Twitch is the anti-model; reference family is 2005–2010 console lobbies + Kaillera chat rooms | Owner, batch 3 | 1 |
| 2026-09-25 | Nothing for sale, nothing to unlock; "No ROM? You can still watch" is the honest ROM-less hook | Owner hates DBFZ/SF6 money grabs; spectators need no ROM (shipped) | 1 |
| 2026-09-25 | Two separate videos (intro; rollback explainer) | Owner, batch 3 | 1 |
| 2026-09-25 | Name kaillera-next; domain kaillera-next.thesuperhuman.us may change; design must not depend on it | Owner, batch 3 | 1 |
| 2026-09-25 | Live rooms board ships with the page, minimal scope (host "list on front page" checkbox, join code for listed rooms, game/host/players/status/Watch/Join, designed empty state) | Owner: Option A, keep scope small — no guarantee of use | 1 |
| 2026-09-25 | Real aggregate activity numbers may be shown; never fake or padded | Owner, brief review | 1 |
| 2026-09-25 | Ko-fi link stays as a quiet footer link | Owner: footer is quiet enough | 1 |
| 2026-09-25 | Design Brief v1 accepted; Phase 2 may start while player answers arrive | Owner, brief review | 1 |
| 2026-09-25 | Page narrative: door (board as hero) → you bring the game → how it works (video) → why it feels close to the couch (proof) → since 2001 → footer | Phase 2 proposal, pending review | 2 |
| 2026-09-25 | Server-waking state = the input-lag visualizer inline as an interactive loading screen | Already built, static, on-topic; console-era callback | 2 |
| 2026-09-25 | Two videos scripted (intro ≈50 s, rollback ≈60 s) under launch-copy rules | Owner: separate videos | 2 |
| 2026-09-25 | Directions are chosen from images, not descriptions: live mockup artifact + GPT prompts per direction | Owner: needs to see it before picking | 2 |
| 2026-09-25 | No generated imagery on the page; real screenshots and real game frames instead; Phase 5 becomes a shot list | Owner didn't care for GPT images; they invented games and taglines (AI-slop anti-reference) | 2 |
| 2026-09-25 | Board carries live previews: a frame per listed room + a featured "Now playing" match with Watch and Join (level L1 recommended) | Owner: "Twitch, but you can actually join"; builds on shipped spectate, late join and game-screenshot plumbing | 2 |
| 2026-09-25 | Direction A (The Lobby) is the direction | Owner: "Yes" | 2 |
| 2026-09-25 | Game imagery: live frames on the board and real screenshots in "How it works"; no recorded attract clip when nothing is live | Owner: "Both"; "An empty state" | 2 |
| 2026-09-25 | Hover-to-stream on the featured panel only, desktop hover / phone tap, debounced and lingering; ship L1 first, hover-stream as first follow-up | Owner's goal "if not too crazy"; assessed medium; host upload is the cost | 2 |
| 2026-09-25 | Phase 5 = shot list of real captures, no generated images | Owner: "Ok" | 2 |
