# Landing page design — kaillera-next

> **Status:** Build plan v1 written (§7), provisional until Phase 6 feedback. Logo: family A chosen in meaning; round 2 (A1–A3) drawn to remove the Windows echo (§5.7c). Outstanding from the owner: logo pick, player-test tables (§6, Appendix C), the two-device photo (S3), Kaillera-player answers (Appendix B), the analytics decision (§7.8). Build starts only when the owner says so, in a separate session.
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

### 2.11 Phase 2 closed — owner's answers (2026-09-25)

| Question | Answer | Effect |
|---|---|---|
| Name box on the front page | Default: stop asking; the room asks | Landing has no form field except "Have a code?" |
| Smash Remix link | Yes, one link | In "You bring the game", to the official project (patches only) |
| The one number | "Matches this week" | Board header + empty state, from session logs |
| Wake the server on every visit | Yes | Static page pings the API on load; waking state if asleep |
| Phone controllers | "I've tested my Xbox controller and it works, idk about anything else" | Copy: "On-screen controls; an Xbox controller over Bluetooth works too." Assumed tested on a phone (flagged to owner). No broader claim. |
| Tone | Sentence case | As drafted |
| Game footage in the videos | Yes | Videos show the game running |

Phase 2 is closed. Direction A; narrative and copy as §2.1–2.2 with the
previews of §2.8; two videos; shot list in Phase 5.


## 3. Phase 3 — User flows (v1, for owner review)

Grounded in what the product does today (play.js, signaling.py, checked
2026-09-25), with the landing-page changes from Phase 2 marked **new**.
Feelings are the target feeling per step; failure paths are what happens
when it goes wrong and what the person should see. Questions at the end of
each flow are the ones only the owner or real players can answer.

Facts the flows rely on:
- Rooms are ephemeral; empty rooms are cleaned up periodically. A room code is
  only valid while its room is alive.
- The play page (`/play.html?room=CODE`) is served by the sleeping server.
  Invite links therefore must land on the **static** site first (**new**),
  which wakes the server and hands off.
- Guests auto-join from the link. Room full → the client retries as a
  spectator and shows a "room is full" banner. Unknown code → "Room not found
  — it may have expired or the code may be incorrect".
- Host's Start is disabled until every player is ROM-ready. Wrong ROM → "Your
  ROM doesn't match the host's game." The ROM library (IndexedDB) auto-picks a
  cached ROM matching the host's hash.
- Refresh mid-game: a per-tab identity + reconnect token reclaim the slot
  within a 30-second grace; lobby host has a 5-second grace.
- Spectators need no ROM; up to 20; host streams canvas video lazily when
  the first spectator connects; a spectator can claim a vacated slot.
- Mobile: portrait shows a "rotate to landscape" toast; a tap-to-start
  gesture unlocks audio; on-screen controls; an Xbox controller over
  Bluetooth works.
- Unsupported browser (no WebRTC, no WebAssembly, or no cross-origin
  isolation): only logged today. Nothing is shown to the person.
- TURN relay is supported if configured (`TURN_SERVERS`/`TURN_SECRET` or
  Cloudflare TURN); whether production has it is unknown (owner question).

### Flow 1 — First-time visitor → understands → video / demo → creates a room

| # | They see | They do | They feel | If it goes wrong |
|---|---|---|---|---|
| 1 | Static front page: name, one line, the board (live / empty / waking) | Read for 5–10 s | "Oh. Smash 64. In the browser." | Server asleep → waking state with the visualizer; the rest of the page is readable meanwhile |
| 2 | Board: rooms with frames, or the empty state with "N matches this week" | Scan who's here | Presence: an arcade at opening time, not a closed one | Nothing listed and a low number → must still read as alive: the number is real, the copy hands them the next move |
| 3a | **Watch** on a live row | Click | Behind the glass, with a door | Room closes mid-watch → "This room closed" + back to the front page |
| 3b | "You bring the game" | Read | Relief or a plan: "I have it" / "I need it" / "I'll watch" | Person has no ROM and expected a download → the section must pre-empt this before they invest |
| 3c | Intro video / demo / lag visualizer | Click one | "Show me" satisfied without a friend | Demo needs a ROM → its own dropzone says so; visualizer needs nothing |
| 4 | **Create a room** | Click | Momentum; no form to fill (**new**: no name box) | Server asleep → button says "ready in a moment"; the waking state is already on screen |
| 5 | Room page, pre-game overlay: Invite (copy link / share), ROM dropzone, player list, controller setup, host options incl. **"List this room on the front page (shows a live preview)"** (**new**), Start (disabled) | Drop the ROM | "It took my file and it knows what it is" (status shows the game name) | Unknown file → "not a supported ROM, it may not work"; wrong type → nothing loads: needs a clear line. Name defaults to "Player" until changed |
| 6 | Invite button | Copy the link, send it | Anticipation | Waiting alone with nothing to do → suggest: controller setup and a one-line "what your friend needs" reminder next to the link |
| 7 | Friend appears in the list; both ROM-ready; Start enables | Press Start | "Here we go" | Friend never comes → host leaves; room cleaned up. Friend arrives without a ROM → Start stays disabled; the host sees why ("waiting for ROMs") |
| 8 | Loading overlay (boot + sync) → game menus → match | Play | "It just worked" | Boot stall, desync, disconnect → Flow 5c |

**Open questions (Flow 1).**
- Owner: is the default name "Player" acceptable at the door, or should the
  room overlay insist on a name before Invite? (Recommendation: allow
  "Player", prompt gently in the overlay.)
- Owner: should Start be allowed with an *unsupported* ROM (today it warns
  but may proceed)? For the landing page's honesty it only matters that the
  warning is explicit.
- Real players (newcomers, Phase 6): after the front page, "what do you
  think happens when you press Create a room?" and "what would you need
  before your friend can play?"

### Flow 2 — A friend opens an invite link cold (phone, no ROM yet) → joins

| # | They see | They do | They feel | If it goes wrong |
|---|---|---|---|---|
| 1 | The link in Discord / iMessage / WhatsApp | Tap | Curiosity, or duty | Opens in the app's **in-app browser**, which may lack cross-origin isolation → the game can't run there. **New:** the join page detects the common in-app browsers and says "Open in Safari or Chrome for the game to run" with a copy-link button |
| 2 | **New: invite-link landing state** on the static site: "Kaz invited you to play Super Smash Bros. 64 · 2/4 in the room · waiting for players", **Join** and **Watch**, one line on what Join needs (your own ROM) and what Watch doesn't | Read, pick | "I know what this is and what it wants from me" | Server asleep → waking state on this page too, with the room lookup retried until it answers. Room gone → "This room closed. Ask for a new link, or open your own." Room full → Watch offered first, "you'll be able to join if a slot opens" |
| 3 | Room page overlay: name (defaults "Player"), ROM dropzone "Tap to choose ROM file", player list with the host's name, controller status | Change name; choose ROM from Files / Drive | On a phone, this is the wall: "I need a file?" | No ROM on the phone → they should already know from step 2; the overlay offers **Watch instead** without leaving (**new** line), so they stay in the room while the friend talks them through it. Wrong ROM → "Your ROM doesn't match the host's game" naming both games (**new** wording). Cached ROM → auto-picked from the library, no drop needed |
| 4 | "Tap to start" gesture prompt; "rotate to landscape" if portrait | Tap, rotate | Small ritual, fine | Audio still silent → the prompt must be the only way in, so it can't be skipped |
| 5 | Loading overlay → game; on-screen controls appear; controller detected if paired | Play | Delight if smooth; if the ROM step was a surprise, resentment that arrived one screen too late | Connection fails → Flow 5c |

**Open questions (Flow 2).**
- Owner: **streaming mode** (host runs the only emulator, guests send inputs)
  needs no ROM on the guest and no cross-origin isolation. Should the join
  page mention it as the no-ROM way to *play* ("ask the host to switch the
  room to streaming"), or is Watch the only no-ROM path we advertise, keeping
  rollback the single story? (Recommendation: Watch only on the page;
  streaming stays a host option inside the room.)
- Owner: what is the exact wording you'd want a friend to see when the room
  has closed? ("Kaz's room closed" vs neutral.)
- Real players (2–3 friends of the owner, on their own phones): send them a
  real invite link in the apps they actually use. Record: which app, whether
  it opened in-app or in Safari/Chrome, whether the file picker found their
  ROM, and the first thing they said. This is the single most valuable test
  in the whole plan.

### Flow 3 — A returning player → back in a room fast

| # | They see | They do | They feel | If it goes wrong |
|---|---|---|---|---|
| 1 | Front page; board shows their friends' listed rooms (if any) | Click **Join** on a friend's room, or **Create** | "My people are here" / two clicks to a room | Nothing listed → Create, send link again |
| 2 | Room overlay: name remembered, ROM auto-picked from the library | Nothing | "My stuff is still here" | Browser data cleared → back to Flow 1 step 5; the overlay says "drop your ROM again" plainly |
| 3 (hot return) | Mid-game refresh or tab crash → "Reconnecting…" overlay | Wait | "Phew" | Within 30 s → same slot, state resynced. After 30 s → slot vacated: rejoin takes an open slot as a late-joiner, else spectate with "your slot was taken while you were away" |

**Open questions (Flow 3).**
- Owner: the reconnect identity lives in *sessionStorage* (per tab). Opening
  the same link in a new tab makes a new identity and can't reclaim the slot.
  Accept, or move the identity to localStorage in the build plan?
- Owner: a "your last room" shortcut on the front page is cheap but rooms
  die within minutes; worth it? (Recommendation: no.)

### Flow 4 — A spectator link

| # | They see | They do | They feel | If it goes wrong |
|---|---|---|---|---|
| 1 | Link (`…&spectate=1`) or **Watch** on the board / featured panel | Tap | "Let me see" | In-app browser without WebRTC → nothing plays: show "open in Safari/Chrome" (same detection as Flow 2) |
| 2 | Invite-link landing state in spectator form: "Watch Kaz's room" + what they'll see | Watch | No ROM asked, no wall | Room not started yet → the room overlay with the player list and "the host hasn't started" |
| 3 | Game as video with audio; player list; **Join** appears when a slot opens | Watch; maybe claim a slot | Behind the glass, with a door | 20 spectators already → "This room is full for spectators" (**new** wording; today's message is unspecified). Host leaves → room closes → back to the front page |

**Open questions (Flow 4).**
- Owner: when a spectator claims a slot they then need a ROM. Should the
  claim button say so ("Join · needs your ROM")? (Recommendation: yes.)
- Owner: is 20 spectators the right public cap for launch given host upload?
  (The featured hover-stream would add to it later.)

### Flow 5 — Rough moments

**5a. Server waking (~1 min).** Static page loads instantly → it pings the
API (`/health`) with a short timeout → no answer → **waking state**: honest
line, elapsed counter, indeterminate bar, the lag visualizer to play with;
Create / Join / Watch disabled with "ready in a moment"; poll every ~3 s;
on the first answer the board fills and buttons enable. Past ~2 minutes:
"Still powering on. If this takes more than a couple of minutes, something's
wrong on our side. Reload, or come back in a bit." Same state on the
invite-link page. Feeling to hit: a machine booting, not a broken site.
*Owner question:* does the free tier stay awake while a host sits in a room
with an open Socket.IO connection, or can the server sleep under a live
room? (Determines whether the friend's invite can ever hit a sleeping server
while the host is waiting.)

**5b. ROM missing or wrong.** Missing: the room overlay's dropzone plus the
new "Watch instead" line; the supported list; the Smash Remix link. Wrong:
"Your ROM doesn't match the host's game. The host is playing Super Smash
Bros. (US). You dropped Smash Remix 2.0.1." Unsupported: "Not a supported
ROM. It may not work. Supported: …". Never: where to get one. *Owner
question:* keep "enable ROM sharing" out of every error message now that
sharing is disabled for these games? (Today one message still says it.)

**5c. Connection trouble.** Can't connect at all (symmetric NAT, no relay):
"Couldn't connect to Kaz. This usually means a strict network on one side."
plus one thing to try (phone hotspot, another network). Drops mid-game: the
existing "Waiting on peer" overlay with a countdown to the 30-second grace,
then "X left the game; their slot is open." Reconnect attempts are
automatic. *Owner question:* is TURN configured in production? Without it,
some pairs can never connect and the page should not claim "just works"
anywhere.

**5d. Unsupported browser.** Today only logged. **New:** a real screen before
anything loads: "This browser can't run the game. It needs a feature
(SharedArrayBuffer) that in-app browsers and some privacy modes turn off.
Open this link in Safari or Chrome." With a copy-link button and, if WebRTC
exists, "or Watch instead". *Real-player question:* which apps do your
friends actually open links from? (Discord, iMessage, WhatsApp, Instagram
DMs each behave differently.)

**5e. Mobile controls.** Portrait → toast "rotate to landscape"; on-screen
controls over the 4:3 canvas; Xbox controller over Bluetooth works; the
controller settings panel exists. *Real-player question (2 phone players):*
after five minutes of play, "which action was hardest to do on the screen?"
and "did you find the controller settings?" We list the answers; we don't
lead.

### Flow questions only the owner can answer, collected

1. Default name "Player" at the door: fine, or insist on a name in the room?
2. Start with an unsupported ROM: allowed with a warning, or blocked?
3. Streaming mode on the join page as the no-ROM way to play, or Watch only?
4. Wording when a room has closed: named ("Kaz's room closed") or neutral?
5. Reconnect identity: keep per-tab, or move to localStorage?
6. "Your last room" shortcut on the front page: yes/no? (Recommend no.)
7. Slot-claim button for spectators says "needs your ROM"?
8. Spectator cap of 20 at launch?
9. Does the free tier stay awake while a host waits in a room?
10. Is TURN configured in production?
11. Remove "enable ROM sharing" from error copy?

### What to ask real players (before Phase 6 if possible)

- **Invite-link test (3 friends, their own phones, the apps they use):**
  send a real link; record app, in-app vs real browser, whether the file
  picker found a ROM, first words. Nothing else.
- **Newcomer front-page test (1–2 people):** "What happens when you press
  Create a room?" "What would your friend need?"
- **Phone play test (2 people, 5 minutes):** "Which action was hardest on the
  screen?" "Did you find the controller settings?"

### Phase 3 closed — owner: "Defaults are fine for all 11" (2026-09-25)

| # | Decision | Note |
|---|---|---|
| 1 | "Player" allowed at the door; the room overlay prompts gently for a name | |
| 2 | Start with an unsupported ROM stays allowed, with an explicit warning | Today's behaviour, made explicit |
| 3 | Watch is the only no-ROM path advertised; streaming stays a host option inside the room | |
| 4 | Room-closed message is named when the host is known ("Kaz's room has closed"), neutral otherwise | My pick under the delegation: a person, not a system |
| 5 | Reconnect identity stays per tab | Two tabs sharing one identity would be worse |
| 6 | No "your last room" shortcut | |
| 7 | Spectator slot-claim button says "Join · needs your ROM" | |
| 8 | Spectator cap stays 20 at launch | |
| 9 | Free tier under a live room: **unknown fact** → the invite page always carries the waking state; verify in build | Build-plan check |
| 10 | TURN in production: **unknown fact** → copy never says "just works"; the connection-failure message ships; verify/configure TURN in build (Cloudflare TURN is already supported by the server code) | Build-plan check |
| 11 | "Enable ROM sharing" removed from all error copy | |

## 4. Phase 4 — Wireframes (v1, for owner feedback)

Low-fidelity. Boxes show placement and hierarchy, not style (style is
direction A, see the mockup). Each numbered element carries the reason it
exists and the Phase 1 goal it serves: **G1** Presence · **G2** Permeability
· **G3** Home for veterans · **G4** Honest proof · **G5** No dead air ·
**H** Honesty (the ROM rule and the no-hype rule) · **N** Newcomer clarity.

### W1 — Landing page, desktop (≥ 900 px)

```
┌────────────────────────────────────────────────────────────────────────┐
│ (1) kaillera-next                                                      │
│ (2) Super Smash Bros. 64 online with friends. In your browser. No install.
│ (3) Free and open source. Continuing Kaillera, 2001.                   │
│                                                                        │
│ ┌ (4) OPEN ROOMS · ● 6 people playing right now · 41 matches this week ┐
│ │ ┌──────────────┐ (5) NOW PLAYING                                    │ │
│ │ │  live frame  │     Super Smash Bros.                              │ │
│ │ │  [LIVE]      │     hosted by Moose · ■■■□ 3/4 · ● in game · 6 min │ │
│ │ │              │     [ Watch ]  [ Join · 1 slot open ]              │ │
│ │ └──────────────┘     Watch drops you in as a spectator. Join takes  │ │
│ │                      the open slot, mid-game, with your own ROM.    │ │
│ ├────────────────────────────────────────────────────────────────────┤ │
│ │ (6) [frame] Smash Remix 2.0.1  Kaz    ■■□□ 2/4  waiting   [Watch][Join]
│ │     [LIVE ] Super Smash Bros.  Moose  ■■■□ 3/4  ● in game [Watch][Join]
│ │     [frame] Smash Remix 2.0.0  Firo   ■□□□ 1/4  waiting   [Watch][Join]
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ (7) [ Create a room ]      Have a code? [______] [Join] [Watch]        │
│ (8) Playing needs your own SSB64 or Smash Remix ROM. Watching doesn't. │
├────────────────────────────────────────────────────────────────────────┤
│ (9) You bring the game                                                 │
│     three short paragraphs · one link: the Smash Remix project         │
├────────────────────────────────────────────────────────────────────────┤
│ (10) How it works                     ┌─────────┐ ┌─────────┐ ┌──────┐ │
│      Create a room and send the link. │ shot 1  │ │ shot 2  │ │shot 3│ │
│      Friends open it on a laptop or a │ room +  │ │ phone   │ │ both │ │
│      phone. Everyone drops their own  │ invite  │ │ joining │ │screens│ │
│      ROM. The host presses Start.     └─────────┘ └─────────┘ └──────┘ │
│      Up to 4 players. Spectators      [ ▶ Intro video · 0:50 ]         │
│      welcome. Keyboard, gamepad or on-screen controls.                 │
├────────────────────────────────────────────────────────────────────────┤
│ (11) Why it feels close to the couch          ┌──────────────────────┐ │
│      four sentences, launch-copy rules        │ ▶ Rollback explained │ │
│      Don't take our word for it.              │        1:00          │ │
│      [Try the demo · needs your ROM]          └──────────────────────┘ │
│      [Lag visualizer · no ROM]                                         │
├────────────────────────────────────────────────────────────────────────┤
│ (12) Since 2001                                                        │
│      paragraph · Kaillera → EmuLinker → … → kaillera-next (ribbon)     │
│      Free and open source (GPL-2). GitHub                              │
├────────────────────────────────────────────────────────────────────────┤
│ (13) by Kazon Wilson (Agent 21) · Inspired by Kaillera by C. Thibault  │
│      GitHub · Support · About · v0.53.0                                │
│      kaillera-next does not host, distribute or link to ROMs.          │
└────────────────────────────────────────────────────────────────────────┘
```

| # | Why it's there | Goal |
|---|---|---|
| 1 | The name carries "Kaillera"; veterans recognise it before reading anything | G3 |
| 2 | One line answers "what is this" in the first second; no adjectives | N, H |
| 3 | "Free, open source, continuing Kaillera" in one breath; also the first no-sale signal | G3, H |
| 4 | Board header: people right now (live) + the one real number (weekly) | G1 |
| 5 | Featured match: the attract mode. Watch and Join side by side, and the caption says what each one costs, so nobody discovers the ROM rule after clicking | G1, G2, H |
| 6 | Rows: a frame per room, slots in player colours, status, Watch / Join. Rows update in place | G1, G2 |
| 7 | Create is the "play" cabinet; the code field serves veterans sharing a code by voice; no name box | G2 |
| 8 | The ROM rule, one line, under the buttons, before anyone commits | H |
| 9 | The full ROM story: nothing hosted, file stays local, the three ROMs, the Remix link, "no ROM? watch" | H, G2 |
| 10 | Three real screenshots first (fast on phones), video second (click to play); newcomer's mental model in one glance | N |
| 11 | Proof, not lecture: the demo and the visualizer, labelled by what they need; the explainer video | G4 |
| 12 | The "you're home" paragraph and the lineage; open source | G3 |
| 13 | Credit, quiet Support, About (personal story lives here), version, and the ROM disclaimer | H, non-goals |

**Board states in the same frame:** *Live* (as drawn). *Empty*: (5)–(6) are
replaced by "The floor is quiet. 41 matches were played this week. Open a
room and send the link. First one in picks the stage." *Waking*: see W5.
When several rooms are in game, the featured one is the most recently
started match **with an open slot** (joinable beats watchable), else the
newest.

### W2 — Landing page, phone (≤ 720 px)

```
┌──────────────────────────┐
│ (1) kaillera-next        │
│ (2) Super Smash Bros. 64 │
│     online with friends. │
│     In your browser.     │
│     No install.          │
│ (4) OPEN ROOMS ● 6 now   │
│ ┌──────────────────────┐ │
│ │ (5) live frame [LIVE]│ │
│ │ NOW PLAYING          │ │
│ │ Super Smash Bros.    │ │
│ │ Moose · ■■■□ 3/4     │ │
│ │ ● in game · 6 min    │ │
│ │ [     Watch        ] │ │
│ │ [ Join · 1 slot open]│ │
│ └──────────────────────┘ │
│ ┌──────────────────────┐ │
│ │[frm] Smash Remix 2.0.1│ │
│ │      Kaz · ■■□□ 2/4  │ │
│ │      waiting [Watch] │ │
│ │              [Join ] │ │
│ └──────────────────────┘ │
│ … more rows …            │
│ (7) [   Create a room  ] │
│     Have a code? ▸       │
│ (8) Playing needs your   │
│     own ROM. Watching    │
│     doesn't.             │
├──────────────────────────┤
│ (9) You bring the game   │
│ (10) How it works        │
│   ◂ shot1 · shot2 · shot3 ▸ (swipe)
│   [▶ Intro · 0:50]       │
│ (11) Why it feels close… │
│   [Try the demo]         │
│   [Lag visualizer]       │
│   [▶ Rollback · 1:00]    │
│ (12) Since 2001 (ribbon  │
│   scrolls sideways)      │
│ (13) footer              │
└──────────────────────────┘
```

Phone rules: (3) is dropped above the fold and reappears in (12); Create is
full width and one thumb from the top after the board; "Have a code?" is a
link that opens the field, so the first screen has no empty input; frames
are 72 px wide, never full-width rows (data); videos are thumbnails only;
nothing autoplays; the featured panel shows **Watch** first because a phone
visitor is the likeliest to have no ROM (G2).

### W3 — Invite-link landing state (static site; desktop and phone alike)

URL: the invite copied from a room becomes a static-site URL
(e.g. `/join?room=ABC123`; the exact scheme is a build decision) that looks
the room up, wakes the server if needed, and hands off to the room page.

```
┌────────────────────────────────────────────────┐
│ (1) kaillera-next                              │
│                                                │
│ (2) Kaz invited you to play                    │
│     Super Smash Bros. 64                       │
│ (3) ■■□□ 2 of 4 in the room · waiting for players
│                                                │
│ (4) [        Join the room         ]           │
│ (5) needs your own SSB64 ROM (.z64/.n64/.v64/.zip)
│ (6) [        Watch instead         ]  no ROM needed
│                                                │
│ (7) What happens next: pick a name, drop your  │
│     ROM, wait for Kaz to press Start.          │
│ (8) Not sure what a ROM is? → You bring the game
│ ────────────────────────────────────────────── │
│ (9) First time here? What this is ↓            │
└────────────────────────────────────────────────┘
```

| # | Why | Goal |
|---|---|---|
| 2 | A person invited you, by name, to a named game: the arcade friend waving you over | G1, N |
| 3 | Live room facts from the server: it's real and it's now | G1 |
| 4–6 | Join and Watch side by side with their costs, before the wall | G2, H |
| 7 | Removes the fear of the next screen | N |
| 8 | The ROM explanation is one tap away, never forced | H |
| 9 | Curious friends can learn; nobody has to | N |

Variants of W3:
- **Room full:** (4) becomes secondary "Join when a slot opens", (6) becomes
  primary. Line: "The room is full right now. Watch, and you'll be able to
  join if a slot opens."
- **Room closed:** (2)–(6) replaced by "Kaz's room has closed. Ask for a new
  link, or [Open your own room]."
- **In-app browser detected** (Discord, Instagram, Messenger, etc.): banner
  above (2): "You're in Discord's built-in browser. Open this link in Safari
  or Chrome for the game to run. [Copy link]". Watch may still work; Join is
  shown but the banner stays.
- **Server waking:** (2)–(6) replaced by the W5 block with the line "We'll
  show Kaz's room the moment the server answers."
- **Spectator link:** (2) reads "Watch Kaz's room", (6) is primary, (4)
  becomes "Join if a slot opens · needs your ROM".

### W4 — ROM-needed state (inside the room page's pre-game overlay)

Not the landing page, but the first thing a joiner meets after it, so it
must keep the same promises.

```
┌────────────────────────────────────────────────┐
│ (1) Room ABC123 · [Invite]         You: [Player]
│ (2) Players  ■ Kaz (host) ✓ ROM   ■ Player (you)
│ ┌────────────────────────────────────────────┐ │
│ │ (3) Drop your ROM here, or tap to choose   │ │
│ │ (4) Kaz is playing Super Smash Bros. (US). │ │
│ │     .z64 / .n64 / .v64 / .zip ·            │ │
│ │     stays on this device                   │ │
│ └────────────────────────────────────────────┘ │
│ (5) Don't have it? [Watch instead] — you stay  │
│     in the room and see the game when it starts│
│ (6) Controller: none detected · [Set up]       │
│ (7) Waiting for Kaz to start…                  │
└────────────────────────────────────────────────┘
```

| # | Why | Goal |
|---|---|---|
| 2 | The host's ✓ ROM shows what "ready" looks like | N |
| 4 | Names the exact game the host has, so the joiner picks the right file first time | H |
| 5 | The no-ROM path without leaving the room; spectate is one tap, the friend is still on the line | G2 |
| 6 | Something useful to do while waiting | G5 |

Variants: **wrong ROM** → red line under (3): "Your ROM doesn't match. Kaz
is playing Super Smash Bros. (US); you dropped Smash Remix 2.0.1. [Choose
another]". **Cached ROMs** → (3) shows the library ("Use Super Smash Bros.
(US)") and the matching one is auto-picked. **Unsupported ROM** → amber line:
"Not a supported ROM. It may not work. Supported: …"

### W5 — Server-waking state (board area of W1; the same block on W3)

```
┌ OPEN ROOMS · powering on ─────────────────────────────────────────┐
│ (1) Powering on…  0:23                                            │
│ (2) The room server naps when nobody's around. Your visit woke it │
│     up; it takes up to a minute. Press SPACE (tap on a phone)     │
│     while you wait. This is what rollback does to lag.            │
│ (3) ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  │
│ (4) ┌ INPUT      (●)────────────────────────────  0 ms ┐          │
│     │ RESPONSE        (●)─────────────────────  +240 ms │          │
│     │            240 ms WAIT PER INPUT                  │          │
│     │ Network lag [====|-----] 120 ms   [x] Rollback on │          │
│     └───────────────────────────────────────────────────┘          │
│ (5) [ Create a room · ready in a moment ]   Have a code? [____]    │
└────────────────────────────────────────────────────────────────────┘
```

| # | Why | Goal |
|---|---|---|
| 1 | Honest state name and a real elapsed counter: a machine booting, not a hang | G5, H |
| 2 | Says why, how long, and what to do meanwhile; the console-era callback is in the tone, not in a costume | G5 |
| 3 | Indeterminate bar: motion without a fake percentage | H |
| 4 | The lag visualizer: on-topic, needs nothing, and teaches the netcode while they wait | G4, G5 |
| 5 | Actions visible but disabled with a reason; they enable in place the moment the server answers | G5 |

Behaviour: page pings `/health` on load (short timeout); waking state on
failure; poll every ~3 s; on first answer the board fills in place and the
buttons enable, no reload. Past ~2 minutes (2) becomes: "Still powering on.
If this takes more than a couple of minutes, something's wrong on our side.
Reload, or come back in a bit."

### Phase 4 questions for the owner

1. **Section order:** as drawn (door → ROM → how → why → since 2001), or
   move "Since 2001" up under the board for veterans? (Recommendation: as
   drawn; veterans get the name in (1) and (3) immediately.)
2. **Featured pick rule:** most recently started match *with an open slot*
   first, else the newest. OK?
3. **"Have a code?" on phone** collapses to a link. OK, or always show the
   field?
4. **Invite URL scheme:** `/join?room=CODE` on the static site (works on any
   static host) versus a prettier `/r/CODE` (needs rewrite rules). Also:
   should the static host proxy the room page so both live on one domain?
   (Build decision; your preference decides.)
5. **W4 lives on the room page,** which has its own current design. Do you
   want the room overlay restyled to direction A in the same build, or only
   the copy and the "Watch instead" line changed now?
6. **Render these in the mockup** before Phase 5 (W3 invite-link and W4
   ROM-needed, in direction A), or go straight to the shot list?

Real players: show one friend W3 as plain text (no styling) and ask "what
would you tap, and why?" Log the answer in Appendix B.

### Phase 4 — owner's answers (2026-09-25) and the rendered wireframes

| Question | Answer | Effect |
|---|---|---|
| Section order | As drawn | Door → ROM → How → Why → Since 2001 → footer |
| Featured-match rule | OK | Newest match with an open slot first, else newest |
| "Have a code?" on phones | "Does it matter?" | A little, only on the first phone screen: an open input invites typing and pushes Create down. Collapsed to a link; one line to flip after the phone test |
| Invite URL scheme + domain | Not answered | Default taken: `/join?room=CODE` on the static site. Build session decides single-domain routing (Cloudflare in front: static landing + join at the edge, everything else to the API) vs two domains with a JS hand-off. Reversible |
| Restyle scope | "Yes, restyle everything accordingly, likely the demo page as well if it's not too much effort" | The room overlay (W4) and the demo page are restyled to direction A in the same build; the lag visualizer inherits the tokens by being embedded |
| Render W3/W4 in the mockup | "Yes please add everything into the mockup so I can critique it" | Done, see below |

**Mockup, updated:** https://claude.ai/artifact/9pPt7Vtvxtxjs5csq7ErM3
Toolbar now has a **Screen** switcher:
- **Landing** (W1/W2/W5): Board Live / Empty / Waking; Live previews on/off;
  the "How it works" block now shows three screenshot slots above the video.
- **Invite link** (W3): six states — waiting for players, room full, room
  closed, in-app browser, server waking (with the visualizer moved in),
  spectator link.
- **Room · ROM needed** (W4): needs ROM, wrong ROM (both games named), cached
  ROM library (auto-matched).
- **Demo**: today's /demo.html layout (stage + sidebar, same copy) in the
  direction's tokens, to judge the restyle.
Direction stays switchable for comparison; A is the default.

**How to critique it (per screen):**
- *Landing:* is Create where your thumb lands on a phone? Does "Watch" read
  as "for me" when you imagine having no ROM? Does the empty state feel like
  opening time or closing time?
- *Invite link:* imagine you're the friend with no ROM: which button do you
  press, and do you understand what happens next before pressing it? Is the
  in-app banner clear enough to make you leave Discord's browser?
- *Room:* with the wrong ROM, do you know exactly which file to find? Does
  "Watch instead" feel like an exit or like staying in the room?
- *Demo:* does the restyle keep the demo readable at a glance (Result, RTT,
  Rollback toggle), or did the look eat the function?

**Owner's critique (2026-09-25): "I have no complaints."** Plus one logic
point: *"I'm not sure how you could reach the state where the system is
waking up when you receive an invite and join it, since the server needs to
be awake for the owner to send it. We'd have to fix the persistence bug
there; I think currently you essentially join a closed game and you'd take
over as the owner, which is probably not good for bookkeeping."*

Checked against signaling.py:
- A join to a missing code returns "Room not found"; joins never create rooms.
- Last person leaves → room deleted at once. Host leaves with others present
  → ownership transfers to the next player (intended).
- **The real bug is the restart path.** With Redis persistence, a restart or
  wake reloads rooms whose sockets are all dead ("zombies"), kept up to
  5 minutes by the cleanup loop. A friend opening the link in that window
  joins a room whose host is a ghost and nobody is the live owner. Without
  Redis the room is simply gone.
- So the invite-waking state is reachable only when the server went down
  between the host sending the link and the friend opening it. It stays in
  the design as the transitional screen (the page can't know the outcome
  until the server answers), but its copy no longer promises the room:
  **"We'll check on Kaz's room the moment it answers."** It then resolves to
  the room (host's open tab reconnected and revived it) or to "Kaz's room
  has closed."
- **Build item (server):** a room with no live sockets is not joinable by a
  *new* player; only a returning player (known persistent id, within grace)
  may re-enter. New joiners get "room closed". Keeps bookkeeping honest and
  removes the ghost-owner case.

Phase 4 closed.

## 5. Phase 5 — Shot list (replaces image prompts; v1 for owner review)

Decided in Phase 2: no generated imagery on the page. Every picture is a
real capture of the real product, plus two videos. This is the list of what
to capture, how, what to keep out of frame, and how to judge the results.

### 5.1 Principles for every capture
- **Real product, real match, consenting people.** Names shown are the
  owner's and one friend who has agreed. No surnames, emails, IPs, passwords.
- **Flat crops, no device mockups.** No floating phone frames, no
  perspective tilts, no drop shadows. A phone screenshot keeps its real
  status bar and browser bar, because "in your browser" is the point.
- **In-match frames only.** No boot screens, no title or copyright screens,
  no character-select close-ups. The game is context, the product is the
  subject.
- **Clean state.** No debug overlays or query flags, no toasts other than the
  one a shot needs, no "rotate to landscape" prompt, no version-mismatch
  reload risk (don't deploy while recording).
- **2× resolution** for stills; 1080p60 for gameplay video.
- **Same zoom, theme and names** across all stills and both videos.

### 5.2 Stills

| ID | Used in | What's in frame | Device / size | Notes |
|---|---|---|---|---|
| **S1** | How it works, shot 1 | The restyled room overlay, host view: room code, **Invite** with the "Link copied" toast showing, two players listed (Kaz ✓ ROM, friend ✓ ROM), Start enabled | Desktop 1440×900 at 2×, cropped to the card with margin | The link is the subject |
| **S2** | How it works, shot 2 | The invite-link page on a phone: "Kaz invited you to play Super Smash Bros. 64", Join / Watch visible, Safari bar included | iPhone, portrait, native screenshot | Shows "no install" without saying it |
| **S3** | How it works, shot 3 | Two devices in the **same match on the same frame** | Either a composite of a desktop capture + phone capture side by side (1600×600), or one photo of both devices on a table | Photo is warmer (people, devices, the arcade); composite is cleaner. Owner picks (Q1) |
| **S4** | Board frames, "no frame yet" | Not a capture: a CSS placeholder tile in the tokens ("waiting…") for rooms with no frame | — | Build item |
| **S5** | OG card, landing | 1200×630: name in direction A type, the one line, "Free · No install · Bring your own ROM" | Pre-rendered with the existing `scripts/generate_og_cards.py` | Refresh to direction A |
| **S6** | OG card, invite link | 1200×630: "Kaz invited you to play Super Smash Bros. 64 · 2 of 4 · kaillera-next" | Static card + dynamic text | Today's cards can carry per-game images (`web/static/og/ssb64.jpg`, `smash-remix.jpg`). Provenance check (Q2): if they are Nintendo art, replace with a UI-only card |
| **S7** | Favicon + wordmark | Wordmark = the direction A name treatment (condensed uppercase). Favicon: the existing "kn" SVG recoloured to the A palette (#0e1218 / #5aa8ff) | SVG | No logo illustration unless the owner wants an exploration (Q3) |

### 5.3 Videos

**V1 — Intro (≈50 s), script §2.4.** Eight shots, in order: landing page
with cursor on Create → click, room page with the invite link → link pasted
into a chat → a phone opening it, landing in the room → both drop a ROM →
host presses Start, split screen booting → a few seconds of play side by
side → URL card. The phone shots are iOS screen recordings; the desktop
shots are browser captures; the split screen is edited, both recordings
started from the same Start.

**V2 — Rollback explained (≈60 s), script §2.4.** Two simple timeline
diagrams (lockstep: each frame waits; rollback: run, predict, short rewind)
made in the direction A tokens as animated SVG or slides, never generated
art; then the demo page: slider to 200 ms, rollback off, stall; rollback on,
smooth; URL card.

**Recording checklist (both):** browser window 1440×900, zoom 110–125% for
legibility; a fresh profile with no bookmarks bar or extensions; mute system
sounds; capture at 60 fps; hold each shot 1–3 s longer than the script for
editing; export 1080p; narration by TTS, one neutral unhurried voice at
~140 words per minute (Q4: voice, or the owner's own); upload the script as
captions so the video works muted in a Discord embed.

### 5.4 Keep out of frame
Real surnames, emails, IPs, room passwords · the debug toolbar and any
diagnostics · error toasts · boot, title and copyright screens ·
character-select close-ups · other people's usernames without consent ·
the desktop behind the browser.

### 5.5 What to look for when the captures come back
1. **Truth test.** Each still shows exactly what its caption says: the link
   is visible in S1, a phone is joining in S2, the same frame is on both
   screens in S3. If a shot needs an arrow to be understood, retake it.
2. **Anti-reference test.** Anything that looks like a stock product
   mockup (device frames, tilts, glows) is rejected. Flat crops only.
3. **Small-size test.** At 160 px wide (the phone swipe row) can you tell
   S1, S2 and S3 apart by shape alone?
4. **Consistency.** Same zoom, theme, names, and the same match across
   S1–S3 and V1.
5. **OG test.** Paste the landing link and an invite link into Discord and
   iMessage. The preview must say who invited you and to what, uncropped.
6. **Video test.** Watch V1 muted with captions: still clear? Read every V2
   sentence against docs/launch-copy.md: no "zero lag", no "fixes lag".
7. **Brief test.** Cover the captions: does the page still feel like a place
   with people in it?

### 5.6 Owner's answers (2026-09-25), first pass

- **Narration: none.** *"Preferably no voice for now, just use text to
  explain it."* → Both videos are silent with short on-screen text cards
  (the script lines, shortened, burned in). Bonus: they work as muted
  autoplay embeds in Discord.
- **Consenting friend: none for now.** → Captures are the owner alone on two
  devices. The second player name is a real handle of the owner's, never
  "Player 2": proposed "Kaz" (laptop) and "Agent 21" (phone).
- Questions 1–3 were asked in shorthand and not understood; restated
  plainly below with defaults.

### 5.6b Owner's answers, second pass (2026-09-25)

- **Third "How it works" picture → a photo.** *"I'll have to take a picture
  when I get a chance."* S3 is a camera photo of the laptop and phone on a
  table, both showing the same moment of the same match; no hands; browser
  bar and status bar visible.
- **Link-preview image.** Owner: *"You sure you know what 'sketchy' looks
  like?"* Fair: the "sketchy ROM site" claim was a pattern guess, not
  something I verified, and it's withdrawn. The reason that stands is IP:
  the box art is Nintendo's copyrighted artwork and trademarks used to
  promote the site, the only place on the page that would show their art
  rather than a player's gameplay, under the owner's own "no legal gray
  areas" rule. Options: **(a)** keep the box art; **(b)** our own card only
  (name, invite text, player-colour slots); **(c)** our own card with a real
  in-match frame as the picture, same category as the live frames.
  Recommendation: (c). **Owner's decision (2026-09-25): (a) while the room
  is waiting, (c) once the game is in progress.** Build implications: the
  in-game invite card is composed at request time from the room's latest
  frame (today's cards are pre-rendered files; a small server-side compose
  with Pillow, 1200×630, name + "Kaz's room · in game" + the frame); frames
  exist only for rooms listed on the front page, so an unlisted room's
  in-game link falls back to (a); no frame yet → (a).
- **Logo: yes, via GPT.** *"A logo would be cool, we can pass a prompt to
  GPT for it."* Prompts in §5.7.

### 5.6a Questions for the owner, restated plainly (superseded by 5.6b)
- **Q1. The third "How it works" picture ("both screens in a match").**
  A camera photo of the laptop and phone on a table showing the same moment,
  or two screenshots (laptop + phone) placed side by side in one image?
  *Default: side by side screenshots (solo-friendly, no photo setup).*
- **Q2. The link-preview image** (what Discord / iMessage / Twitter show
  when a link is pasted). Checked: `web/static/og/ssb64.jpg` is the **official N64 box
  art** (Mario, Pikachu, Samus, Fox, the "Only for N64" mark, ESRB badge).
  `home.png` is the current generic card (Inter Bold on navy, "Play retro
  games online with friends · no install needed · up to 4 players", a big
  "kn" watermark). Recommendation: **OG cards go UI-only**, in direction A
  type, for the landing page and every invite. Box art next to "bring your
  own ROM" is exactly the look of the sketchy-ROM-site anti-reference, and
  it is trademark art we don't need. `GAME_IMAGES_ENABLED=false` already
  turns the per-game images off without a code change. Confirm?
- **Q3. A logo.** The site has none today (the name as text + a tiny "kn"
  tab icon). Do you want a symbol/mark designed? If yes, a generated sketch
  of ideas (no Nintendo content) is the one remaining use for GPT images.
  *Default: no logo for now; the direction A name treatment is the wordmark
  and the "kn" icon gets the new colours.*

### 5.7 Logo prompts for GPT (ready to paste)

Three concepts grounded in the project, not in anyone's IP: the four
player colours, the rollback idea, the existing "kn" monogram. One concept
per run; paste the shared rules at the end of every prompt.

**Shared rules (paste at the end of each prompt):**

> Flat vector logo, solid shapes, no gradients, no 3D, no shadows, no glow.
> No mockups: no business cards, signage or app-store frames. No mascots, no
> characters, nothing resembling Nintendo logos, Nintendo characters, the
> Smash Bros. emblem or the N64 controller shape. No pixel-art font, no
> neon, no chrome. Present four things in one square 1024×1024 image on a
> dark charcoal-navy background #0e1218: the mark alone; the mark with the
> wordmark "kaillera-next" in a tall condensed bold uppercase sans (Barlow
> Condensed feel), off-white #e8ecf1; a 32×32 favicon version; and the mark
> in plain white on black.

**Concept 1 — Four slots**

> Logo for kaillera-next, a browser site where up to four people play a
> 1999 four-player fighting game online together. The mark is four small
> rounded squares in the four player colours: red #e5484d, blue #3b82f6,
> yellow #f5c518, green #3fb950. VARIATION: [V1] arranged in a 2×2 grid with
> one square nudged slightly outward, like a slot that just opened. [V2] a
> horizontal row of four with the last square drawn as a hollow outline, an
> open slot. [V3] the four squares plus two thin stems forming a capital K.
> Mood: a console-era online lobby: composed, quiet, confident, a place
> rather than a product. The hyphen in the wordmark may be the only accent
> in electric blue #5aa8ff.

**Concept 2 — Run and rewind**

> Logo for kaillera-next, a browser netplay site whose engine runs the game
> ahead and quietly rewinds when a prediction misses. The mark is a single
> monoline symbol in electric blue #5aa8ff that combines a play triangle
> with a rewind loop; even stroke weight, slightly rounded corners, must
> read at 32 pixels. VARIATION: [V1] a play triangle whose left edge
> continues into a circular arrow. [V2] two rounded rectangles (frames)
> offset by a few pixels with a small arrow between them. [V3] one
> continuous stroke that draws a play triangle and loops back under it.
> Mood: composed, technical without jargon, quiet confidence.

**Concept 3 — The kn monogram**

> Logo for kaillera-next, a browser netplay site continuing Kaillera
> (2001). The mark is the letters "kn" as one geometric lettermark, the n
> sharing the k's stem, tall and condensed, off-white #e8ecf1 on a rounded
> square of #151b25 with a thin #242c39 border; one small electric-blue
> #5aa8ff bar or dot is the only colour. VARIATION: [V1] kn inside the
> rounded square, favicon first. [V2] kn drawn as one continuous stroke.
> [V3] the k's upper arm becomes a small forward arrow, for "next". Mood:
> composed, quiet, could have been the icon of a 2007 console lobby.

**What to look for when the images come back**
1. Shrink each to 32 px. If the mark turns to mud, it fails.
2. The white-on-black version: if it needs colour to work, it fails.
3. Anything echoing the N64 "N" cube, the Smash emblem or a three-prong
   controller is out.
4. Gradient orbs, swooshes, shields, hexagons, "tech" rings: AI-logo tropes,
   out.
5. Put the mark next to the mockup header. Does it belong with the
   condensed type?
6. Say in one sentence what the mark means. If you can't, nobody will.

**Owner (2026-09-25): "I don't like any of the logos GPT generated."**
All rejected. Options offered: (1) no logo: the direction A name treatment
is the wordmark, the "kn" tab icon recoloured; (2) a few flat vector marks
drawn by hand into the mockup header and at favicon size, same three
concepts, judged in context. Recommendation: (2), because every decision so
far came from the mockup, not from generated images.
**Owner: "Try drawing some yourself I guess."**

### 5.7b Hand-drawn candidates (in the mockup, Screen → Logo)

https://claude.ai/artifact/9pPt7Vtvxtxjs5csq7ErM3#logo — four flat SVG
marks, each shown large, in the header lockup, at 32 px and 16 px on a dark
and a light tab bar, and in plain white; "Apply to header" puts the mark on
the Landing and Invite headers so it's judged in place.

| | Mark | Means | Known risk |
|---|---|---|---|
| **A** | Four slots: 2×2 rounded squares in the player colours, the fourth hollow | Four players, one seat open. The same shape already sits on every board row, so the logo *is* the UI. A 1×4 row form doubles as a wordmark underline | Reads as "colour swatches" to someone who hasn't seen the board |
| **B** | Run and rewind: a play triangle inside a three-quarter arc with an arrowhead | The game runs ahead and loops back when a guess misses | Can read as a "refresh" icon |
| **C** | kn monogram: geometric k and n strokes in a rounded square, the k's upper arm in blue | The initials; the blue arm is a small "next" | Monograms are common; lives or dies on the letterforms |
| **D** | Wordmark only: the name in the condensed face with a blue hyphen; tab icon = "KN" recoloured | Nothing but the name | No symbol to carry alone (e.g. a Discord server icon) |

How to judge (same six tests as §5.7): 16 px first, white-on-black second,
no Nintendo echoes, no AI-logo tropes, belongs with the condensed type, can
be explained in one sentence.

**Owner (2026-09-25): "A reminds me of the Windows logo; my wife doesn't
like the white, but she likes A the most."** Two data points from two
people: the meaning of A (four seats, one open) lands; the 2×2 arrangement
echoes Microsoft's logo (a 2×2 of the same four colours), which is a
trademark we must not resemble. "The white" is read as the white-on-black
one-colour version; to be confirmed.

### 5.7c Round 2 — A without the Windows echo (in the mockup, below round 1)

Same meaning, no 2×2 grid. One-colour versions left out.

| | Mark | Means | Known risk |
|---|---|---|---|
| **A1** | Around the cabinet: four squares in a plus arrangement around an empty centre, the east one hollow | Four seats around one machine (or couch, or table); the open seat; also reads as a plus: join in | Plus shapes can read as "add" or medical |
| **A2** | Four ports: four upright bars side by side, the fourth hollow | The N64's signature was four controller ports on the front; one is free | Can read as an equaliser |
| **A3** | The board's row: the exact slot marker from every room row, in a tile | The logo is literally the interface; strongest as the wordmark underline | Weakest at 16 px, the squares get tiny |

_Owner's pick from round 2: pending. If none, say what's wrong with the
closest and round 3 starts from it._

## 6. Phase 6 — Put it in front of people (v1)

A short guide for testing the chosen design with 3–5 real people. The point
is to watch what they do and write down what they say, not to convince them.

### 6.1 Who
- 1–2 **old Kaillera / Smash 64 players** (the "feel at home" test)
- 1–2 **friends you'd actually send a link to** (the invite test)
- 1 **person who has never used an emulator** (the newcomer test)
Mix devices: at least two on their own phone, at least one on a desktop.

### 6.2 Setup (per person, 20–30 minutes, one at a time)
- Remote screen-share or in person. They use **their own device**.
- Say only this: *"I'm testing a web page, not you. There are no wrong
  answers. Please think out loud: say what you're looking at and what you'd
  do. I won't help unless you're truly stuck."*
- Record with permission, or type notes **verbatim**. Don't paraphrase.
- Don't explain the project first. Don't say "rollback", "netcode",
  "ROM" or "Kaillera" before they do.
- Materials: the live mockup (direction A) at
  https://claude.ai/artifact/9pPt7Vtvxtxjs5csq7ErM3 (share it with them
  first; it's private by default), set to Landing · Live · previews on.

### 6.3 The session, in order

**1. Five-second test.** Show the Landing screen for five seconds, then hide
it. Ask: *"What is this?" "What can you do here?" "Who is it for?"* Then
show it again for as long as they want and ask if anything changed.

**2. Task: play with a friend.** *"You want to play with a friend tonight.
Show me what you'd do."* Watch: do they find Create? Do they read the ROM
line? What do they say when they see it?

**3. Task: the invite.** Switch to the Invite link screen (Waiting for
players). *"A friend just sent you this. What do you do?"* Watch: Join or
Watch, and whether they understand what Join needs before pressing.

**4. Task: no game file.** *"Suppose you don't have the game file. What
now?"* Then switch to the Room · ROM needed screen: *"You've pressed Join
and this is what you see. What next?"* Watch what "Watch instead" means to
them.

**5. Task: waking.** Landing screen, Board set to Waking. *"You've just
opened the page and this is what you see. What's happening? What would you
do?"* Watch: wait, reload, or leave? Do they press SPACE or tap?

**6. Veterans only: since 2001.** Scroll to the "Since 2001" section.
*"What does this make you feel?" "Anything wrong or missing?"* Record
names they mention.

**7. Phone only.** On their phone, Landing screen: *"Find how to start a
room."* then *"Find how to watch a match."* Watch thumb reach, scrolling,
and whether "Have a code?" is found when asked *"A friend gives you a code
over voice. Where does it go?"*

**8. Optional, the real thing.** If they're willing, send them a real
invite link from the current site in the app they normally use. Record:
which app, whether it opened inside the app or in Safari/Chrome, whether
the file picker found a ROM, first words. (This is the Phase 3 test; it is
the most valuable thing on this list.)

**9. Wrap-up, open questions only.**
- *"Describe this site to a friend in one sentence."*
- *"What would stop you from using it?"*
- *"What did you expect to find that wasn't there?"*
- *"Does it remind you of anything?"* (If they name something: *"What about
  it?"*)

### 6.4 What not to ask, what not to do
- No leading questions: not "isn't it clear that…", not "do you like the
  arcade feel?", not "does it feel like Kaillera?"
- No yes/no questions when an open one will do.
- No "would you use this?" (people say yes to be kind) and no questions
  about features that don't exist.
- Don't explain, defend, or apologise for anything on the page.
- Help only after 60 seconds of being stuck, then write it down as a
  failure of the page, not of the person.

### 6.5 How to record (one table per person, Appendix C)
For each task: what they did, in order · time to the first right action ·
where they got stuck · their words, verbatim · one line of surprises. Then
the wrap-up answers verbatim.

### 6.6 How we'll read it
- A problem seen with **2 or more of 5 people** is real and gets fixed.
- Success signals from the brief, checked per person: could they say what
  the site is in one sentence after five seconds; did a veteran say
  "Kaillera" or "this is like…" unprompted; did anyone call it a startup,
  an AI page, or a ROM site; did anyone ask where to get the game without
  finding the answer on the page.
- Bring the filled tables back here; I tally the patterns and propose the
  revisions, and we iterate the mockup before the build plan.

_Awaiting the owner's return with feedback._

## 7. Build plan (v1, provisional until Phase 6 feedback is in)

For a separate build session. Everything below was decided in Phases 1–5;
items marked **⚠** may change after the player tests (§6). Read the Design
Brief (§1) and the flows (§3) first; this section is the checklist.

### 7.1 Scope in one paragraph
A static landing page in direction A (the console-era lobby) whose hero is
a live board of open rooms with frames, a featured match you can Watch or
Join, Create, a code field, one honest ROM line, then four short sections
(You bring the game · How it works · Why it feels close to the couch · Since
2001) and a quiet footer. A static invite-link page with six states. The
room overlay and the demo page restyled to the same tokens. Server work to
make the board real: listed rooms, join codes, frames, a weekly number, the
zombie-room rule, ROM sharing off for the known ROMs. No chat, profiles,
rankings, avatars, roadmap, AI mention or personal story on the page.

### 7.2 Milestones, in build order

**M0 — Server and hosting plumbing** (nothing visible yet)
1. `ROM_SHARING_ENABLED=false` in production for the known copyrighted ROMs
   (flag already exists in `signaling.py` / `og.py`). Remove "enable ROM
   sharing" from every client error string.
2. Zombie-room rule: a room with no live sockets is not joinable by a new
   player; returning players (known persistent id, within grace) may
   re-enter; new joiners get `Room closed` (distinct from `Room not found`).
3. Rooms board data: host checkbox **"List this room on the front page
   (shows a live preview)"** → `room.listed`; never true for password rooms.
   `GET /list` returns, for listed rooms only: `room_code`, `game`,
   `host_name`, `player_count`, `max_players`, `status`, `started_at`,
   `frame_url`, `frame_age_s`. Unlisted rooms keep today's shape (no code).
4. Frames (L1): host of a *listed, in-game* room posts a ≤20 KB JPEG
   (~320×240) every ~10 s (reuse the `game-screenshot` path with a
   non-debug, listed-only variant). Server keeps only the latest per room
   in memory, drops it when the room closes. Served at `frame_url` with
   `Cache-Control: no-store`. **Build check:** cost per listed room is one
   small upload per 10 s; confirm on the free tier.
5. Weekly number: `GET /api/stats/public` → `{ "matches_this_week": N,
   "people_playing_now": M }` from session logs + live rooms. Real or
   absent; never padded.
6. Public health for the waking state: `GET /health` already exists; make
   sure it answers fast and CORS-allows the static origin.
7. OG cards: landing card in direction A type (UI-only); invite card =
   box art while waiting (`GAME_IMAGES_ENABLED` stays on), **composed at
   request time from the latest frame once in game** (Pillow, 1200×630:
   name + "Kaz's room · in game" + the frame). No frame or unlisted → the
   waiting card.
8. **Build checks (facts unknown at design time):** does the free tier stay
   awake while a host holds a Socket.IO connection? Is TURN configured
   (`TURN_SERVERS`/`TURN_SECRET` or Cloudflare TURN)? Record both answers
   in this doc; adjust copy in 7.4 if TURN is absent (never "just works").
9. Hosting: static landing + `/join` on an always-up host; the API on the
   sleeping tier. Preferred: one domain with Cloudflare in front (static at
   the edge for `/` and `/join`, everything else to the API). Acceptable:
   two domains with a JS hand-off from `/join` to `/play.html`. Invite
   links copied from a room must point at the static `/join?room=CODE`.

**M1 — Landing page** (`web/index.html` replaced; static, no framework)
- Beats 1–6 as §2.1/§4 W1–W2, copy from 7.4.
- Board states: **live** (poll `/list` every 10 s, back off to 30 s when
  the tab is hidden; rows update in place; featured = newest in-game room
  with an open slot, else newest), **empty**, **waking** (health ping on
  load with a 2 s timeout; poll every 3 s; the lag visualizer inline; past
  120 s the "still powering on" line), **error** (health answers but `/list`
  fails: "Couldn't load rooms. Reload." with Create still enabled).
- No name field. "Have a code?" inline on desktop, a link that opens the
  field on phones ⚠.
- Live previews: a 72 px frame per row, the featured panel with the frame
  as poster; **no hover-to-stream in this build** (first follow-up).
- Three screenshot slots + click-to-play intro video (lite-embed: poster
  image, the YouTube iframe injected on click); explainer video the same.
- Footer as today plus the ROM disclaimer; Ko-fi stays a text link.

**M2 — Invite-link page** (`/join?room=CODE`, static)
- Looks the room up via `GET /room/{code}` (already exists; add `host_name`
  and `listed`), wakes the server if needed (same waking block).
- States: waiting for players · room full (Watch primary) · room closed
  (named host if known) · in-app browser banner (UA detection for Discord,
  Instagram, Facebook/Messenger, TikTok, Twitter; copy-link button; Watch
  still offered) · server waking ("We'll check on Kaz's room…") ·
  spectator link (`&spectate=1`: Watch primary, "Join if a slot opens ·
  needs your ROM").
- Hands off to `/play.html?room=CODE[&spectate=1]` on the API host.

**M3 — Room overlay and demo restyle** (`play.html`/`play.css`, `demo.html`)
- Tokens from 7.5; layout as W4: host ✓ ROM visible; dropzone names the
  host's exact game; **"Watch instead"** switches to spectator without
  leaving; wrong-ROM message names both games; cached ROM auto-matched with
  the library visible; unsupported ROM warns and still allows Start.
- New **unsupported-browser screen** before anything loads when
  `RTCPeerConnection`, `WebAssembly` or `crossOriginIsolated` is missing:
  what's missing in plain words, "Open in Safari or Chrome", copy-link, and
  "or Watch instead" when WebRTC exists.
- Spectator slot-claim button reads "Join · needs your ROM"; spectators-full
  message: "This room is full for spectators."
- Demo page: same layout and copy, new tokens; the "Play with friends" card
  points at the front page.
- Name: "Player" allowed; the overlay prompts gently.

**M4 — Assets** (§5)
- S1, S2 (screenshots), S3 (the owner's two-device photo), S5/S6 OG cards,
  S7 favicon recolour (+ the chosen logo once picked from §5.7), V1/V2
  silent videos with text cards, uploaded to YouTube with captions.
- Screenshots as WebP ≤ 60 KB each with `width`/`height` set; the photo
  ≤ 120 KB.

**M5 — Launch checklist**
- Phase 6 revisions folded in ⚠.
- Real invite-link test from three apps on phones (§3 Flow 2) passed.
- Two-player `tests/rb-two-player.mjs` with `JITTER=20` still passes
  (CLAUDE.md rule: the restyle touches play.html, not the tick loop, but
  run it).
- Launch order per docs/launch-copy.md: r/Smash64 → r/smashbros →
  r/emulation → X → r/fightinggames → Show HN last.

### 7.3 States, complete list
| Page | States |
|---|---|
| Landing board | live · empty · waking · error · (waking > 120 s) |
| Landing featured | present (in-game room exists) · absent |
| Invite | waiting · full · closed · in-app browser · waking · spectator · unsupported browser |
| Room overlay | needs ROM · wrong ROM · cached ROM · unsupported ROM · watching instead · unsupported browser |
| Global | server unreachable after wake timeout |

### 7.4 Copy, final (supersedes §2.2 where different)
- Line: "Super Smash Bros. 64 online with friends. In your browser. No
  install." Sub: "Free and open source. Continuing Kaillera, 2001."
- Board: "Open rooms · N people playing right now · N matches this week".
  Empty: "The floor is quiet. N matches were played this week. Open a room
  and send the link. First one in picks the stage."
- Under Create: "Playing needs your own SSB64 or Smash Remix ROM. Watching
  doesn't."
- Featured caption: "Watch drops you in as a spectator. Join takes the open
  slot, mid-game, with your own ROM."
- Waking: as §2.2; invite variant: "We'll check on Kaz's room the moment it
  answers."
- You bring the game: as §2.2, with one link on "Smash Remix" to the
  official project.
- How it works: as §2.2 plus "On a phone, an Xbox controller over Bluetooth
  works too."
- Why it feels close to the couch: as §2.2 (checked against
  docs/launch-copy.md). If TURN is absent (7.2 M0.8), add nothing that
  implies every pair can connect.
- Since 2001, footer: as §2.2. Footer adds "kaillera-next does not host,
  distribute or link to ROMs."
- Room closed: "Kaz's room has closed. Rooms live only while someone's in
  them. Ask Kaz for a new link, or open your own."
- Wrong ROM: "Your ROM doesn't match. Kaz is playing Super Smash Bros.
  (US); you dropped Smash Remix 2.0.1."
- Connection failure: "Couldn't connect to Kaz. This usually means a strict
  network on one side. Try a phone hotspot or another network."
- Unsupported browser: "This browser can't run the game. It needs a feature
  (SharedArrayBuffer) that in-app browsers and some privacy modes turn off.
  Open this link in Safari or Chrome."
- Sentence case throughout; no exclamation marks; no "zero lag", "no input
  delay", "fixes lag", "eliminates rollbacks", "faster than offline".

### 7.5 Tokens (direction A)
```
--bg #0e1218  --bg2 #151b25  --line #242c39  --text #e8ecf1  --muted #8b95a5
--accent #5aa8ff  --accent-ink #061020  --radius 4px
--p1 #e5484d  --p2 #3b82f6  --p3 #f5c518  --p4 #3fb950
display/labels: Barlow Condensed 600/700 (uppercase, tracking .04–.12em)
body: IBM Plex Sans 400/500/600 · tabular numerals on the board
```
Fonts self-hosted, subset to Latin, `font-display: swap`, preloaded; two
families, five weights total. The demo, room overlay and lag visualizer
inherit the same variables.

### 7.6 Accessibility
- Contrast: muted on bg ≈ 5.5:1, accent on bg ≈ 7:1, accent-ink on accent
  ≥ 10:1; verify after any token change.
- Board updates announced via `aria-live="polite"` on the header count
  only (not every row); waking state is `role="status"`.
- Every frame has alt text: "Live frame from Kaz's room"; placeholder tiles
  are `aria-hidden`.
- Slot markers never the only signal: the "3/4" count sits beside them.
- 44 px minimum targets on phones; visible focus rings (2 px accent).
- `prefers-reduced-motion` disables the breathing dot, progress bar and
  visualizer pulses.
- Videos: captions uploaded; no autoplay anywhere.
- Headings in order (h1 name, h2 per beat); `lang="en"`; the code input
  has a label; buttons say what they do ("Join · needs your ROM").

### 7.7 Performance on slow phones
- Static HTML + CSS + ~6 KB inline JS (board poll, waking, visualizer,
  lite-embed). No framework, no third-party scripts, no analytics SDK.
- Budget for the first view: ≤ 150 KB transferred (HTML + CSS + fonts),
  LCP under 2.5 s on a mid-range Android on 4G, zero layout shift (the
  board area has a `min-height` in every state).
- Frames: ≤ 20 KB JPEG, `loading="lazy"` below the featured one, fetched
  only while the tab is visible.
- Screenshots WebP ≤ 60 KB with dimensions set; the photo ≤ 120 KB; videos
  never load until clicked (poster + click → iframe).
- Polling: `/list` every 10 s visible, 30 s hidden, stop after 10 minutes
  idle until the next interaction.
- The waking-state visualizer is the same inline JS as `/lag-test.html`,
  no extra download.

### 7.8 Measuring the success signals (needs one decision)
The brief's signals (create/join/watch within 60 s, invite openers reaching
"in game", demo starts, 7-day returns) need counts. Proposal: log them
through the existing `POST /api/client-event` endpoint, server-side counts
only, no third-party analytics, no cookies beyond what the room already
uses. In plain words: the page reports a handful of events ("invite
opened", "joined", "in game", "demo started") to our own server; counts
only; no Google Analytics or any tracker. If declined, the brief's numeric
signals are dropped and only the player tests remain. **Owner to confirm**
before build.

### 7.9 Explicitly not in this build
Hover-to-stream (L2), chat, profiles, records, rankings, avatars, a
roadmap, any mention of AI assistance, the personal story on the page,
streaming mode on the join page, a "your last room" shortcut, generated
imagery.

### 7.10 Open items carried into the build session
- ⚠ Phase 6 player-test revisions (§6).
- Logo pick from §5.7 images; the two-device photo (S3).
- Kaillera-player answers (Appendix B) may adjust the "Since 2001" copy.
- 7.2 M0.8 build checks (free-tier sleep, TURN).
- 7.8 analytics decision.

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

## Appendix C — Session record template (copy once per person)

```
Person: <handle or initials>   Group: vet / friend / newcomer   Device: phone / desktop   Date:

1. Five-second test
   What is this?            "<verbatim>"
   What can you do here?    "<verbatim>"
   Who is it for?           "<verbatim>"
   After a longer look, what changed?  "<verbatim>"

2. Play with a friend
   Actions in order:  …
   Time to Create:    …s     Stuck at: …
   Said about the ROM line:  "<verbatim>"

3. The invite
   Pressed: Join / Watch / other     Understood what Join needs before pressing? y/n
   Said: "<verbatim>"

4. No game file
   Said / did:  "<verbatim>"     "Watch instead" means to them: "<verbatim>"

5. Waking
   Did: wait / reload / leave / pressed SPACE or tapped     Said: "<verbatim>"

6. Since 2001 (vets)
   Feels: "<verbatim>"     Wrong or missing: "<verbatim>"

7. Phone
   Start a room: found in …s   Watch a match: …s   Code field: found? y/n

8. Real link (optional)
   App: …   Opened in-app / real browser   File picker found ROM? y/n/n-a   First words: "<verbatim>"

9. Wrap-up
   One sentence:      "<verbatim>"
   Would stop them:   "<verbatim>"
   Expected, missing: "<verbatim>"
   Reminds them of:   "<verbatim>"

Surprises (one line):
```

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
| 2026-09-25 | No name box on the landing page; the room asks. One Smash Remix link. "Matches this week" is the number. Wake on every visit. Sentence case. Videos show the game. Phone copy: on-screen controls + Xbox controller over Bluetooth | Owner, Phase 2 close-out | 2 |
| 2026-09-25 | Invite and spectator links land on the static site first (invite-link landing state), which wakes the server and hands off to the room | Play page is on the sleeping server; a cold friend must never see a blank page | 3 |
| 2026-09-25 | New states required by the flows: in-app-browser notice, unsupported-browser screen, "Watch instead" inside the room overlay, room-closed message, spectators-full message | Today these are logged or unspecified | 3 |
| 2026-09-25 | Flow defaults accepted: "Player" allowed, unsupported ROM allowed with warning, Watch is the only no-ROM path advertised, named room-closed message, per-tab identity, no last-room shortcut, slot-claim says "needs your ROM", 20 spectators, ROM-sharing wording removed; free-tier sleep and TURN become build checks | Owner: "Defaults are fine for all 11" | 3 |
| 2026-09-25 | Wireframes W1–W5 drafted (landing desktop/phone, invite-link, ROM-needed, waking) with per-element goal annotations | Phase 4 v1 | 4 |
| 2026-09-25 | Section order as drawn; featured = newest match with an open slot; code field collapses to a link on phones; invite URL `/join?room=CODE` on the static site (routing decided in build) | Owner answers + defaults | 4 |
| 2026-09-25 | Restyle the room overlay and the demo page to direction A in the same build | Owner: "restyle everything accordingly" | 4 |
| 2026-09-25 | Wireframes accepted; invite-waking copy changed to "We'll check on Kaz's room"; build item: rooms with no live sockets are not joinable by new players | Owner: no complaints; zombie-room analysis of the restart path | 4 |
| 2026-09-25 | Phase 5 is a shot list: 7 stills (incl. OG cards, favicon), 2 videos, recording checklist, critique tests | Owner: no generated imagery | 5 |
| 2026-09-25 | Videos are silent with on-screen text cards; captures are the owner solo on two devices with real handles; third picture is a photo | Owner, Phase 5 answers | 5 |
| 2026-09-25 | "Sketchy ROM site" claim about box art withdrawn (unverified); the IP reason stands; link-preview options a/b/c, (c) recommended | Owner challenged the claim | 5 |
| 2026-09-25 | A logo will be explored via three GPT prompt concepts (four slots, run-and-rewind, kn monogram), no Nintendo IP | Owner: "a logo would be cool" | 5 |
| 2026-09-25 | Link-preview card: box art while waiting, real in-match frame once in game (composed at request time; unlisted or frameless rooms fall back to box art) | Owner's decision after the IP note | 5 |
| 2026-09-25 | Phase 6 guide: 3–5 people, nine steps, no leading questions, verbatim records, 2-of-5 rule | Phase 6 v1 | 6 |
| 2026-09-25 | Build plan v1: five milestones (M0 plumbing → M1 landing → M2 invite → M3 restyle → M4 assets → M5 launch), full state list, final copy, tokens, accessibility, slow-phone budget; provisional until Phase 6 | Owner asked "what's next" while tests are pending | 7 |
| 2026-09-25 | GPT logos rejected; four hand-drawn SVG candidates (four slots, run-and-rewind, kn monogram, wordmark-only) added to the mockup for in-context judgement | Owner: "Try drawing some yourself" | 5 |
| 2026-09-25 | Logo family A (four seats, one open) preferred by owner and his wife; the 2×2 grid echoes the Windows logo, so round 2 rearranges it (cross, four ports, board row) | Owner + wife feedback | 5 |
