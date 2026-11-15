# kaillera-next — Feature Roadmap (EmuLinker-K Modernized)

> **Status: All V1 phases complete.** Current focus is V2: Mupen64Plus desktop client,
> Kaillera protocol compatibility, and KREC recording/playback.

## Context

V1 netplay shipped as a browser-based WebRTC platform with lockstep and streaming modes.
This roadmap captures the features inspired by EmuLinker-K / classic Kaillera, modernized
for P2P WebRTC + browser. All six phases are done.

---

## Phase 1: Cheat Sync -- Standard Online Config [done]

SSB64 RNG drives items, stage hazards, and physics. All players must start with identical game
config or the game diverges silently on frame 1. We apply a hardcoded standard online config
automatically on all clients when netplay starts -- no host configuration required.

**Cheats applied (N64 GameShark format, sourced from smashboards/smash64.net):**
- `810A4938 0FF0` -- Have All Characters (Captain Falcon, Ness, Jigglypuff, Luigi)
- `800A4937 00FF` -- Have Mushroom Kingdom + Item Switch menu access
- `800A4D0B 0002` -- Stock Mode
- `800A4D0F 0004` -- 5 Stocks
- `800A4D11 0001` -- Timer On
- `800A4D24 0000` -- Items Off
- `810BA9F1 0000+800BA9F3 0000` -- No Wind

**Files:** `web/static/netplay-rollback.js`. No server changes.

---

## Phase 2: Frame Delay / Lockstep [done]

Without delay, both players apply local input at frame T but remote input arrives at T+lag ->
both machines diverge. Solution: delay N frames, applying frame-T inputs at T+N so
both players have received each other's input before applying it.

**Protocol change:** `Int32Array([mask])` 4 bytes -> `Int32Array([frameNum, mask])` 8 bytes.

**Files:** `web/static/netplay-rollback.js`.

---

## Phase 3: 4-Player + Spectators [done]

Classic Kaillera supports up to 4 players. EJS supports ports 0-3.

**Architecture: Full mesh P2P** -- each of 4 players connects directly to the other 3 via
RTCDataChannel (6 connections total, 3 per client). No host bottleneck, no extra relay hop.
Host's only special role is orchestrating WebRTC offers/answers for newcomers via Socket.IO.

**Spectators:** slot = null, receive game feed, no input send. Can claim vacated player slots.

**Files:** `web/static/netplay-rollback.js` + `server/src/api/signaling.py`.

---

## Phase 4: Join / Leave Running Games [done]

Drop-in / drop-out quality of life inspired by EmuLinker-K.

**Late join:** Host sends save state blob via Socket.IO `data-message` -> new player loads it
via `gameManager.loadState()`, then syncs at next delay boundary.

**Player departure:** Vacated slot zeroed (buttons released), spectators can claim it via
`claim-slot` Socket.IO event.

**Files:** `web/static/netplay-rollback.js` + `server/src/api/signaling.py`.

---

## Phase 5: Desync Detection + Auto-Resync [done]

**Detection (star topology, host-authoritative):** Two hashing paths:
1. C-level (patched core): `_kn_sync_hash()` hashes game-specific RDRAM regions directly
   in C. Per-region checksums via `_kn_sync_hash_regions` for targeted desync diagnosis.
2. JS fallback: FNV-1a hash of RDRAM via direct HEAPU8 access, falling back to
   `getState()` serialization.

Host broadcasts `sync-hash:frame:hash:cycleMs` every ~120 frames (~2s). Guests compare
their own hash — mismatch triggers resync.

**Resync (host-authoritative):** Desynced client sends `sync-request` -> host exports state
via `_kn_sync_read()` (C-level) or `getState()` (JS fallback), compresses and sends via
DataChannel in 64KB chunks -> guest buffers state for async application at next clean frame
boundary via `_kn_sync_write()`. No mid-frame stall — gameplay continues during transfer.

**Diagnostics:** Sync log ring buffer, per-region hash logging on mismatch, drift rate
tracking, exportable CSV logs via `debug-sync` Socket.IO event.

**Files:** `web/static/netplay-rollback.js`, `server/src/api/signaling.py` (debug-sync,
debug-logs events), `server/src/api/app.py` (POST /api/session-log).

---

## Phase 6: C-level Rollback Netcode [done]

Lockstep + frame delay is responsive up to ~100 ms RTT; past that, input lag becomes
painful. Rollback adds speculative execution: the local client predicts remote inputs
(last-known value), steps forward, and if the real input arrives differently, rewinds
via state restore + replay. Built entirely in C for bit-exact replay semantics.

**C engine (`build/kn_rollback/`):** state ring buffer, frame-tagged input ring,
prediction tracking, amortized replay (1 frame per tick), taint bitmap for RDRAM
write tracking. Exposes `kn_pre_tick` / `kn_post_tick` / `kn_feed_input` /
`kn_game_state_hash` / `kn_taint_rdram`.

**Cross-device determinism fixes required to make mobile↔mobile work:**
- `invalidate_cached_code_hacktarux` after `retro_unserialize` (JIT cache stale)
- SoftFloat FPU for bit-exact cross-browser floating-point (separate shipped earlier)
- `platform_emscripten_should_drop_iter` forced false in deterministic mode (Safari
  was silently skipping frames on transient tab-hidden events)
- `dp.fb` framebuffer tracker serialized across save/load
- RSP HLE taint hooks for direct `memcpy(hle->dram + addr, ...)` writes that bypass
  `memory.h` store helpers (alist_save, envelope saves, cicx105, mp3 decoder)
- GLideN64 taint hooks for ColorBuffer/DepthBuffer → RDRAM copybacks
- Symmetric delay negotiation: guests defer `kn_rollback_init` until the host's
  authoritative `rb-delay:` broadcast arrives, preventing asymmetric rollback/lockstep
  protocol mismatch across peers

**Final mobile↔mobile test:** 80/80 RB-CHECK matches over 7m 53s with bit-identical
16 MB save buffers across iPhone and iPad. Match terminated by WebRTC DC drop, not
desync. Rollback activates automatically when the WASM core exports `kn_pre_tick`
(current patched core does); no UI mode selector needed.

**Files:** `build/kn_rollback/kn_rollback.{c,h}`, `build/patches/mupen64plus-rsp-taint.patch`,
`build/patches/gliden64-rdram-taint.patch`, `build/patches/mupen64plus-static-save-scratch.patch`,
`web/static/netplay-rollback.js` (deferred init, RB-CHECK, input audit, knDiag).

**Followup:** WebRTC DC reconnect when Socket.IO signaling survives — shipped: a 30s
server-side disconnect grace period plus client-side reconnect retries (see CHANGELOG.md).

---

## Phase 7: Frontend overhaul (TypeScript, Effect, XState, Quint, LemmaScript) [in progress]

The frontend moves from plain scripts to a typed core in `web/src/`, bundled
to `web/static/dist/kn-core.js` and exposed as `window.KNCore`. Each stage
ships on its own and leaves the site working; nothing is rewritten in place
without the old code running beside it first.

**Rules for every stage**

- New logic decides from the change it lands in; nothing observes. The
  change makes the page or engine call the new module and deletes the copy
  it replaces. The site has too little traffic for production reports to
  show agreement, so the evidence comes before the merge, end to end as in
  stage 2: an old-against-new test that runs both on the same inputs before
  the old one is deleted, the proofs and models, and runs of the engine the
  logic belongs to, with a fault mode for each rare path:
  `tests/rb-two-player.mjs` and the lifecycle tests for rollback;
  `tests/test_streaming_*.py` and a real-ROM streaming run for streaming
  (`rb-two-player.mjs` opens `mode=rollback` only). A rule no run reaches gets
  a fault mode or a harness step before it decides. A difference the new
  logic is meant to make (a fix the model shows, like those listed for the
  per-peer machine below) is asserted by the test and named, with its model
  scenario, in the PR; any other difference blocks the change.
- Still observing, each to be switched to deciding that way (the old code
  decides and the new reports a difference): the play page's moved decisions
  (`play-disagree`), the decoding of server messages and of messages peers
  author (`protocol-mismatch`), the mesh rules (`mesh-disagree`), the
  per-peer machine (`peer-disagree`), the resync request rules
  (`resync-disagree`), the streaming rules (`streaming-disagree`) and the
  demo page's run state. Once all of them decide, the observer plumbing
  (`createComparer`, `tests/observer-reports.mjs`) goes too.
- Anything touching the tick loop, sync, input or the core needs
  `tests/rb-two-player.mjs` with `JITTER=20` to pass before merge.
- State logic is modelled in Quint first; pure functions with a contract are
  proven with LemmaScript.
- Every machine has a diagram generated from it, and the scenarios of the
  Quint models are drawn as sequence diagrams from the traces the model
  checker replays. `docs/netcode-diagrams.md` lists them all.

**Stage 1: foundation [done]**
Toolchain (TypeScript 7, esbuild, oxfmt, oxlint + anti-slop, Biome, antislop,
Quint, LemmaScript) and CI. First modules: `protocol.ts` (Effect Schema for
server messages), `session.ts` (page lifecycle machine, observing), `roster.ts`
(mesh-heal target selection, proven never to return the player's own id).

**Stage 2: the page lifecycle decides [done]**
`play.js` reads its lifecycle from the machine in `web/src/session.ts` and
keeps no flags of its own. Production had too little traffic to show that
the machine agreed with the page, so the evidence was end-to-end:
`tests/lifecycle-e2e.mjs`, `tests/rb-two-player.mjs` with
`DROP_SIGNALING_MS` and `tests/solo-signaling-drop.mjs` compared the two at
every read and reported no disagreement before the old flags were deleted.

- Done: "is a game on", "is the next engine start a late join" and "is the
  page waiting for a ROM" are the machine's states (diagram in
  `docs/session-machine.md`, same states in the Quint model). The old
  `gameRunning`, `_lateJoin` and `_pendingLateJoin` are deleted.
- Done: which connection a rejoining player keeps is `rosterKey` in
  `web/src/peer-identity.ts`, called by the engine. Its search is proved
  (LemmaScript) and the reconnect orderings are model-checked in
  `specs/peer_identity.qnt`, which reproduces #119 and its review finding on
  the older variants.
- Done: reconcile on reconnect. A guest whose socket comes back compares
  itself with the status and match id the rejoin returns
  (`reconcileRejoin` in `web/src/rejoin.ts`, proved; `rejoined` in the
  machine) and returns to the lobby, or rejoins the new match, when the room
  moved on without it. `pagesAgreeWithServer` and
  `lateJoinersChaseTheCurrentMatch` now hold on `room_current`.
- Done: a joiner who asks for the match state before the host is running
  is admitted to the start instead of waiting for ever (host replies
  `join-the-start`). The joiner's wait is the first Effect program in the
  engine's path (`web/src/late-join-wait.ts`): repeated request, a race
  between the two answers, a deadline with a recovery action, cancelled when
  the engine stops. `joinersAreNotLeftWaitingAtTheStart` holds on
  `room_current`.
- Done: the rejoin after a socket drop is an Effect program
  (`web/src/rejoin-attempt.ts`): each attempt has a deadline, an unanswered
  or rate-limited attempt is repeated, and every ending is an outcome the
  page handles. The rejoin says it is a resume and names its slot and match
  (`extra.resume`, `slot`, `matchId`). A player the server dropped while its
  socket was down (the grace window ran out) may still be playing over the
  players' own connections: the server takes it back into the same match
  and slot, and refuses otherwise, in which case the page ends its game and
  joins again as a fresh page would (`rejoinRefused` in the machine).
  `nobodyIsStrandedInADroppedMatch` holds on `room_current`. A dropped host
  that is taken back returns as a player; the room stays with whoever it was
  handed to, and the page's host UI follows the server's owner.
- Done: a playing room nobody is running is ended by the server. It
  tracks the players who joined after a match began and have not got into
  it (`Room.waiting_for_state`); a page says it is in with `match-joined`,
  sent when the machine reaches `running` after a mid-match join. When only
  waiting players are left the match ends (`match_is_abandoned`). This was
  the open `noGhostMatch` question; the property is now
  `anAbandonedMatchIsEnded` and holds on `room_current`.
- Done: a page that loaded as host and was dropped from its room joins it
  as a guest when the room has been handed on, instead of failing to open
  it. (A host that still owns its room cannot fall behind it: only the
  owner starts and ends games.)
- Done: an outage that hits every player does not end their match. While
  no player of a playing room is connected, the server keeps the dropped
  players' places past the 30 s grace window (up to 5 minutes) instead of
  emptying the room; before, both players came back to a deleted room and
  were sent to the lobby (found by `tests/rb-two-player.mjs` with
  `DROP_SIGNALING_MS=40000`, which the earlier stage 2 changes had only run
  with a 3 s outage). `aMatchIsNotLostToTheGraceWindow` holds on
  `room_current`.
- Done: the rejoin is a state machine of its own
  (`web/src/rejoin-machine.ts`, diagram in `docs/session-machine.md`):
  `rejoining` invokes the rejoin program, and leaving the state (the socket
  drops again, the game ends, a newer connection arrives) interrupts it.
  The session runs it beside the lifecycle machine, hands it the current
  connection's request and turns a refusal into `rejoinRefused`. It is a
  second machine, not a region of the first, so the lifecycle machine's
  states, which the page reads in the same tick as each event, keep their
  shape.

**Stage 3: the socket boundary**
Every Socket.IO and DataChannel message is decoded with Effect Schema on
arrival. Generate the client schemas from the server's Pydantic models so
there is one source of truth. `play.js` becomes `web/src/play/*.ts`.

Done so far: `scripts/gen_protocol.py` writes `web/src/protocol.gen.ts` from
`server/src/api/payloads.py` (`npm run protocol`; CI fails when it is stale).
The payloads the server sends have models there too, and `signaling.py` holds
every one to its model as it goes out (`_emit`, `checked`): a mismatch raises
under tests and logs `PAYLOAD-CONTRACT` in production. The page decodes every
server-authored event and the `join-room` ack (`web/src/socket-boundary.ts`),
observing: a message off its schema is reported as `protocol-mismatch` and the
handlers still run on the raw payload. Next: handlers move onto decoded values,
and a message off its schema is dropped. Messages peers author (DataChannel control
strings and JSON, and the `data-message` / `webrtc-signal` / `rom-signal`
relays) are described in `web/src/peer-protocol.ts` and checked the same way;
DataChannel strings are sampled (the first 16 of each kind) because they
arrive on the tick path. The per-frame input packet is `input-wire.ts`.

`play.js` is moving to `web/src/play/*.ts` in slices, each read back through
`window.KNCore.play`. Moved: ROM identity (`rom.ts`: host ROM from a payload,
identity key, size text, hash and hash comparison, ROM out of an archive) and
room text (`room-text.ts`: HTML escaping, closed-room message, invite links,
join/leave toasts), and the ROM library (`rom-library.ts`: IndexedDB storage
with its version-1 upgrade, and the list markup; `play.js` keeps what loading
a ROM does to the page), and input delay (`delay.ts`: the words beside the picker, and, observing,
a player's delay preference: `play.js` still decides it and a difference is
reported as `play-disagree` through `observe.ts`), and, observing, the control
remap wizard (`remap-wizard.ts`: the steps, what a captured button, stick or
key does to the mapping, Back and Skip; `play.js`'s wizard is still in charge
and each input is compared; whether an input is taken, ignored or rejected is
`remap-step.ts`, proven with LemmaScript). Moved as they were, being page
effects with nothing to compare: the page's passing messages and small menus
(`notices.ts`: toasts, the error card, the room-full banner; `menus.ts`: the
invite menu, share or copy, the More menu). Observing: a guest receiving the
host's ROM (`rom-transfer.ts`, decisions proved in `rom-transfer-step.ts`,
modelled in `specs/rom_transfer.qnt`); `play.js`'s receiver is in charge and
keeps the channel, the timers and the page. The host's sending side and the
WebRTC set-up are still `play.js`. What the room shows is `room-view.ts`
(each player slot, the spectator line, the in-game info panel; the Start
button's rule is observed, `play.js` still decides it). Joining a room:
the `open-room` and `join-room` requests are built in `connect.ts` and typed
against the generated schemas, with what each refusal means; whether a page
comes in as a spectator and how it gets into a match already under way are
`join-plan.ts` (proved), observed, with `onConnect` still deciding. What a
page does when the host starts a game (watch, keep the host's ROM offer up,
wait for the transfer, stop on a ROM that is not the host's, or boot) and
whether it has a game's end to handle are `game-start.ts` (proved), which
`onGameStarted` and `onGameEnded` ask and carry out. Left in
`play.js`: the reconnect banner's timers, what the game lifecycle handlers do
to the page, and engine start-up, which are effects on the page, the socket
and the emulator.

**Stage 4: engine periphery [done]**
`shared.js` (input wire format; prove encode/decode round-trips with
LemmaScript), `kn-state.js`, `gamepad-manager.js`, `kn-diagnostics.js`,
`kn-desync-detector.js`. The engine calls `KNCore.meshHealTargets` instead of
its inline roster loops.

Done, first: the decisions and arithmetic of each script became typed
functions in `web/src`, with the script's own code kept as a fallback until
production showed no difference. A test per script holds the TypeScript to
output captured from the script before the move.

- Proved (LemmaScript): the input packet round trip (`input-wire.ts`), the
  stick dead-band's per-axis rule (`stick-axis.ts`), `classifyRunnerStep`,
  `inputEqual`, and which fields the desync detector flags
  (`desync-fields.ts`).
- Typed and tested, not proved (floating point and typed arrays, which the
  verifier does not model): the sync log ring, the diagnostics' pixel hash,
  canvas health, screenshot crop and audio transition (`diagnostics.ts`),
  and the gamepad axis scaling and polarity (`gamepad-axes.ts`).
- `KNState` is typed and built in `kn-state.ts`; the bundle sets it as it
  loads and `kn-state.js` is gone. `core-redirector.js`, whose fetch callback
  can run before the bundle, keeps its one value in `localStorage` itself.
- Both engine roster loops ask `meshHealTargets`, one entry at a time.
- Two inputs the scripts used as read are decoded with Effect Schema first:
  a peer's desync digest (`desync-digest.ts`) and a saved gamepad profile
  (`gamepad-profile.ts`). One that does not fit is dropped or ignored.

The scripts themselves are TypeScript too (#170 to #174): `kn-state.js`,
`shared.js`, `gamepad-manager.js`, `kn-diagnostics.js` and
`kn-desync-detector.js` are gone, their code is `web/src/kn-state.ts` and
`web/src/page/*.ts`, and the bundle sets the same globals (`KNState`,
`KNShared`, `KNEvent`, `GamepadManager`, `KNDiag`, `KNDesync`) as it loads,
right after `storage.js`. The JavaScript fallbacks are deleted; the tests
import the TypeScript.

The three waits that were bare timers are Effect code (`web/src/poll.ts`):
the gamepad manager's hot-plug poll, and `waitForEmulator` and
`disableEJSInput` in `page/shared.ts`. Each still looks first in the call
that starts it and then every 200 ms (500 ms for the pads), for the same
number of looks as before.

**Stage 5: the engine**
`netplay-rollback.js` (18k lines) is split by concern into typed modules:
peer mesh, signaling, late join, resync, tick loop. The per-peer and boot
phase state become machines; the per-frame tick loop stays plain code. The
netplay invariants I1 (every wait has a deadline) and I2 (all peer cleanup
through one function) become Effect timeouts and scoped finalizers.

Slice 1, the peer mesh and signaling:

- Done: the connection between two players is modelled in
  `specs/peer_connection.qnt` (who offers, offer and roster in either order,
  reconnect, the mesh health check, #119 from the pair's side). Four
  properties are violated by today's engine and hold on the model's `fixed`
  variant, which is what the per-peer machine will be built to:
  `oneInitiatorPerPair` (both pages can run the health check and offer at
  once), `everyWaitHasADeadline` (a page that answers a reconnect offer
  without having noticed the drop is reconnecting with no deadline),
  `neverLeftWithNothingPending` (after crossed offers both pages can be left
  reconnecting with nothing armed: the match is frozen) and
  `staleSignalsAreNotApplied` (an answer to an earlier attempt is applied to
  the connection that replaced it). None is fixed yet.
- Done (observing): the engine runs the proved functions of
  `web/src/peer-signaling.ts` beside its own decisions (who offers, what a
  signal does to the connection table, what a lost connection leads to, when
  to stop retrying, which entries a new player replaces) and reports a
  difference as a `mesh-disagree` client event. Next: the engine calls them
  and its own rules are deleted.
- Built: the per-peer machine, `web/src/peer-connection.ts` (diagram in
  `docs/peer-connection-machine.md`). One machine per other player, built
  to the model's `fixed` variant: the lower slot is the pair's one
  initiator, every wait in a match has a deadline (delayed transitions,
  durations given as input), signals and channel events carry the attempt
  they belong to and one for another attempt is ignored, and a roster
  update never replaces an open connection. An attempt is named by the page
  that made the offer and that page's count of its offers: the count alone
  starts again at 1 on a page that replaces another (a reload), and a
  signal or channel event of the old page's connection then passes for the
  new one's (the model's `reload`, violated on its `counter_only` variant).
  It decides with the proved functions in `peer-signaling.ts` and makes no
  WebRTC call: what it wants done it issues as commands.
  `tests/ts/peer-connection.test.ts` replays the model's scenarios against
  it. Its runner takes each event at once (XState's pure `transition`) and
  returns the commands; its deadlines run as Effect sleeps.
- Done (observing): the engine runs that machine beside itself, one per
  other player for as long as the page is loaded
  (`web/src/peer-observe.ts`). Every `webrtc-signal` now carries
  `attemptId: {page, attempt}`: a random id the page makes once when it
  loads and its count of the offers it has made to that player. An offer
  carries its own, an answer and a candidate that of the offer their
  connection was made for; the server relays it (`_WEBRTC_KEYS`). The
  engine brackets each event it acts on (the roster, an offer, an answer, a
  candidate, a channel that opened, a connection found lost, the end of a
  player, its startup, attempt, give-up and answer timers, the health
  check) and reports what it did in the machine's words. The machine is
  handed the same event, and a difference in what each did, or in what
  each holds afterwards (an entry, an open channel, reconnecting), is
  reported once as a `peer-disagree` client event (and `PEER-DISAGREE` in
  the sync log); that player is not watched again on that page. The
  engine's timers take the machine's deadline for the same wait when they
  fire, and the machine's own run 5 s late (the health check's an hour), so
  what is compared is what is done at a deadline, not when.
  Nothing accepts or rejects a signal by its id yet.
  A signal without an id comes from a page from before it: that player is
  left alone, not reported. The model shows why it has to be
  (`oldPageAnswersWithNoLabelTest`): a page that goes by the id drops an
  old page's answer, its own included, and the two never connect.
- Not wired: spectators, a page that joined a match in play, a player held
  as a late joiner, more than one machine per player on a page (a player
  this page offered to before it watched them is left alone), and the
  machine's view of the health check's timing (it runs on the engine's).
  The four properties are still violated by the engine; next, the machine
  decides, one rule at a time, and the engine's copy of each is deleted.
- Differences the observer is expected to report, where the engine is not
  what the model's `fixed` rules say (none came up in the two-player and
  lifecycle runs, which reconnect at most once):
  - the health check offers from the higher slot too (`heal`);
  - a page that answers a reconnect offer without having noticed the drop
    has no give-up (`deadline:giveUpAfter`, from the machine);
  - an answer or a candidate for an earlier attempt is handed to the
    connection that replaced it (`answer`, `candidate`);
  - a page already reconnecting that finds its connection lost again
    starts another reconnect (`lost`);
  - between a reconnect attempt's deadline and its retry the engine waits
    3 s; the machine offers at once;
  - from the game's start (the first channel open) until the match runs, a
    lost connection is dropped by the engine and retried by the machine,
    and the engine stops its startup retries for the other players;
  - the answerer's 10 s timer also runs before the match, and does nothing
    once the connection is `connected`, channel or not;
  - a startup connection that opened and was then lost gets two retries
    from the engine, three from the machine;
  - a roster that lists a reloaded player under a new id makes the engine
    drop the entry it has; the machine keeps it until the new page offers.
  The server relays `startupReconnect` (it used to drop it), so a page
  tells a startup retry from a reconnect by the offer's flag, and so does
  the observer. A reconnect offer without it falls back on the page's own
  phase, as every one did before; then a page that had started (in a room
  of three, its channel with another player opened first) took a startup
  retry for a gameplay reconnect and resynced during boot
  (`startupRetryToAStartedPageTest`).
- Driven by tests too: `tests/rb-two-player.mjs` with `DROP_PEER_MS`
  closes the guest's connection to the host mid-battle and drops their
  WebRTC signaling for that long, so the host's reconnect attempt times out
  and is retried; every run of it and of the lifecycle scenarios now fails on
  a `peer-disagree` or `resync-disagree` (`tests/observer-reports.mjs`). The
  first run (`DROP_PEER_MS=12000`, `JITTER=20`) reconnected on the second
  attempt with no disagreement and no mismatch.
- Next: decide, one rule at a time, by the machine, starting with who
  offers from the health check.

Late join, ahead of its slice: two gaps `specs/late_join_pause.qnt` listed
as not modelled are now modelled.

- A joiner made a player while the host is still paused for another one.
  The model has the host's channel to each joiner and the joiner's own
  pause. Two properties: the new player waits for the host (it is paused,
  or a pause is on its way: `aNewPlayerWaitsForTheHost`), and a joiner's
  pause has a deadline (`joinerPauseHasADeadline`, I1). The engine already
  holds both: `finishLateJoinReady` sends the new player `late-join-pause`
  when the pause is kept, `sendLateJoinState` pauses every other peer with
  an open channel, a joiner included, `resumeLateJoinPause` resumes every
  peer, and the joiner's page runs the guest's 20 s deadline. Nothing
  changed in the engine for this one
  (`aNewPlayerPausesWithTheHostTest`, `aPlayerPausesForTheNextJoinerTest`).
- A joiner's channel to the host closing during its serve (a lost
  connection, or the host's own disconnect at the 15 s deadline), and
  opening again. The host ends the serve (`resetPeerState`), so its timer
  and a compression still running do nothing, and resumes if no one else
  is held. But a state already sent through the server is still loaded,
  and the joiner's "ready", held until its channel opens
  (`_pendingLateJoinReadySids`), made it a player on a state the host had
  run past. Violated before (`aJoinerIsNotMadeAPlayerBehindTheHost` on
  `late_join_pause_before_resync`, 7 steps). Fixed: a joiner whose channel
  to the host closed while it waited or loaded (`_lateJoinLostHost`) asks
  for a full resync once it has loaded and the channel is open
  (`_resyncAfterLostHost`), as a running player does after a reconnect.
  The resync is the regular one, with its own deadline; none of this ran
  in the two-player and lifecycle runs, which lose no channel mid-serve.
- That marker was first cleared when the request was sent, so a request
  that went unanswered (the host's rate limit, a failed capture, a lost
  answer) left the joiner behind the host for good
  (`late_join_pause_marker_at_send`, `resyncRequestUnansweredTest`, 8
  steps). It now stays until a host state is applied (`applySyncState`);
  the request's deadline (`RESYNC_REQUEST_TIMEOUT_MS`, 8 s, longer than the
  host's 5 s rate limit) asks again, and after
  `LATE_JOIN_LOST_HOST_MAX_ASKS` (3) unanswered asks the joiner gives up
  visibly (`LATE-JOIN-LOST-HOST-GIVEUP`, client event
  `late-join-lost-host-giveup`).
- Still not modelled: a "ready" that arrives before the joiner's channel
  has ever opened (the host resumes without the joiner and makes it a
  player when the channel opens), and a channel lost by a joiner who is
  already playing (the regular reconnect path).

Resync, ahead of its slice: the guest's resync request rules (#213, #221),
modelled in `specs/resync_flow.qnt` and `specs/late_join_pause.qnt`.

- Done (proved, observing): the rules are pure functions with contracts in
  `web/src/resync-request.ts`, checked by the `proofs` CI job: which state
  ends the request that is out (`endsRequest`, the model's
  `onlyItsAnswerEndsARequest`), which state answers an older request
  (`answersAnOlderRequest`), which late answer is dropped because, applied,
  it would take the guest back: from before the frame the guest is on or the
  frame the newest request named (`isLateAnswerBehind`,
  `aLateAnswerDoesNotTakeTheGuestBack` / `lateAndBehind`), which is set
  aside because the newest request's answer is already held
  (`keepsAwaitedAnswer`, `theAwaitedAnswerIsNotLost`), and what a late
  joiner that lost its channel to the host does next: nothing, wait for the
  channel, wait for the request already out, give up after
  `LATE_JOIN_LOST_HOST_MAX_ASKS`, or ask (`lateJoinLostHostStep`). The
  engine keeps its own rules in charge (`_endsResyncRequest`,
  `_answersAnOlderRequest`, `_isLateAnswerBehind`,
  `_keepsAwaitedAnswer`, `_resyncAfterLostHost`), runs the proved function
  beside each on the same inputs through `window.KNCore.resyncRequest`, and
  reports a difference as a `resync-disagree` client event (and
  `RESYNC-DISAGREE` in the sync log). None came up in the two-player runs,
  plain or with the host or the guest frozen for 8 s.
- Driven by tests too: `tests/rb-two-player.mjs` with
  `DELAY_SYNC_ANSWER_MS` holds the host's answer past the guest's request
  deadline, so the answer arrives after a second request
  (`sync state is not the answer awaited`); `tests/lifecycle-e2e.mjs`
  scenario `late-join-lost-host` closes the joiner's connection to the host
  as the state arrives (marker, `LATE-JOIN-LOST-HOST-RESYNC`, then `the
  lost-host resync is done`). No disagreement in either. In the first, the
  late answer to an immediate request was applied and took the guest back
  130 frames before the awaited answer took it forward again (the hashes
  still matched, but for about 1.5 s the guest made no new frame, so input
  in that window was never sampled): the rules then dropped a late answer
  only when the newest request named a frame. The model now forbids it
  (`immediateLateAnswerTest`, violated on `resync_flow_frame_named`), and a
  late answer is dropped when it is behind the guest's own frame too
  (`SYNC-LATE-ANSWER-DROPPED`). Dropping every older answer (rule a,
  `resync_flow_drop_older`) holds the properties as well, but also drops a
  late answer ahead of the guest when the host's rate limit dropped the
  newest request (`onlyStateComingTest`); dropping only below the frame the
  guest asked from (rule b, `resync_flow_asked_from`) still takes it back.
- That case left the guest with nothing coming: the host had dropped the
  newest request, the guest dropped the only answer, and the request's
  deadline let it go and asked nothing, so a guest that had asked "now"
  (a reconnect, a network change) ran on with the state it had asked to
  replace (`specs/resync_reask.qnt`, `anOwedResyncIsNotForgotten`,
  `lateAnswerBehindTest`). A "now" request now owes a resync until a host
  state is applied; its deadline asks again, at most
  `RESYNC_MAX_ASKS_AGAIN` (2) times, then gives up visibly
  (`RESYNC-REASK-GIVEUP`, client event `resync-reask-giveup`). The deadline
  no longer counts while an answer is being decoded (bounded by
  `SYNC_DECODE_GRACE_MS`): asking again there would make that answer an
  older request's (`theDecodedAnswerIsNotCut`,
  `askAgainCutsTheDecodeTest`). The deadline's step is
  `resyncDeadlineStep`, proved and observing like the rules above.
  `tests/rb-two-player.mjs` with `DOUBLE_RESYNC_ASK=1` drives it: two
  requests at once, the second rate-limited, the first's answer dropped.
- Next: the engine calls the proved functions and its own copies are
  deleted. `DOUBLE_RESYNC_ASK` reaches them; a lifecycle resync that
  actually happens needs a fault mode first.
- A state transfer starving the inputs behind it (`specs/tick_deadlines.qnt`,
  `input_link`). Two `DELAY_SYNC_ANSWER_MS` runs failed with 83 and 40
  gameplay mismatches and 76 and 20 `DEEP-MISPREDICT-SKIP`. The prediction
  window's guard held; it leaves out a phantom peer by design, and the guest
  made the host a phantom at the peer-stale deadline (5 s) while the host's
  inputs sat unsent behind two answers' worth of state (2.9 MB) on the
  shared connection (the host's input channel stood at 5.7 KB buffered). The
  guest then ran 38 to 84 frames past the window. Fixed: the host hands its
  state over a chunk at a time, waiting for the channel to hold less than
  256 KB (`KNCore.syncSend`, `mayHandChunk` proved, the wait an Effect
  program with a 15 s deadline per chunk, `SYNC-SEND-STALLED`); a request
  that comes in meanwhile is queued, not dropped. The two-player harness
  counts what its simulated link holds in the `sync-state` channel's
  `bufferedAmount`. After the fix the delayed run at 90 s had no mismatch
  and no deep rollback, and so did the plain, frozen-host, frozen-guest and
  dropped-peer runs.
  Known limit: on links under about 170 kbit/s one 64 KB state chunk takes
  more than 3 s, so the guest's progress deadline still fires and the
  transfer falls back to the socket; nothing is planned unless production
  shows it.

**Stage 6: the remaining page scripts**
The other hand-written scripts of the play, demo and landing pages move to
`web/src` the way `play.js` does: the logic becomes strict TypeScript and the
script shrinks to a thin caller or leaves the page. A decision moves and
decides in the same change, checked against the old code by a test before the
old code is deleted; a page effect with nothing to compare moves as it is.
One file, or one small group, per change, smallest risk first:

1. `feedback.js`, `version.js`, `version-guard.js`, `storage.js`,
   `kn-capture.js`, `kn-vision-client.js`, `switch2-usb.js`
2. `controller-settings.js`, `virtual-gamepad.js`
3. `kn-audio.js`
4. `netplay-streaming.js`
5. `demo.js`, `fake-peer.js`, `ssb64-menu-autopilot.js`,
   `rollback-timeline.js`
6. `landing.js`, `join.js`

Done so far:

- Items 1, 2, 3 and 6 are done. Each of those scripts is now a few lines
  that start its module from `web/src`: `feedback.js` (#214), `version.js`
  (#211), `version-guard.js` (#206), `kn-capture.js` (#179),
  `kn-vision-client.js` (#195), `switch2-usb.js` (#197),
  `controller-settings.js` (#198), `virtual-gamepad.js` (#209) and
  `kn-audio.js` (#202). Or it has left the page: `storage.js` (#178), and
  `landing.js` (#212) and `join.js` (#181), which are now the `kn-landing.js`
  and `kn-join.js` bundles.
- Item 5's three helpers are done: `fake-peer.js` (#210),
  `ssb64-menu-autopilot.js` (#201) and `rollback-timeline.js` (#200). Of
  `demo.js` itself, these are in `web/src/demo` (#186): the options its
  address takes, the network dial, the HUD's text, the ROM it accepts and
  the recorded menu script. What remains is the page's wiring: booting the
  emulator, starting the engine, and connecting the fake peer and the
  autopilot to it.
- `netplay-streaming.js` (item 4): its decisions are typed functions in
  `web/src/streaming` that run beside the engine and report
  `streaming-disagree`. These cover the roster, the signals and the input
  path (#183), and the video choices (#185). Two of them decide rather than
  observe: which offers a page receiving the stream takes (`offer-gate.ts`,
  #220), and which connection a signal belongs to, together with the host's
  deadline to offer again (`attempt.ts`, `reoffer.ts`, #223, built to
  `specs/streaming_connection.qnt`).
- Next: the engine calls the observed functions and its own copies are
  deleted, one rule at a time, each with a real-ROM streaming run that
  reaches it (connect, input, a dropped guest, a reconnect). Then move the demo page's wiring.

Not every page has `window.KNCore`, and some of these scripts run before it:

- The play and demo pages load `kn-core.js` early, before the first script
  that needs it, and reach the moved logic through `window.KNCore`.
- The front page and the admin dashboard load no core. What they share with
  the play page (`storage.js`, `version.js`, `version-guard.js`,
  `feedback.js`) is written without Effect and also built into a small
  bundle of its own for them.
- `landing.js` and `join.js` ship in their own small bundles beside
  `kn-wake-art.js`: the landing pages must stay light and are served while
  the server sleeps.

What each needs before merge:

- `kn-audio.js` is on the audio path of a rollback match and needs
  `tests/rb-two-player.mjs` with `JITTER=20`.
- `virtual-gamepad.js` is on the input path, but the two-player test feeds
  inputs from the menu autopilot and never touches the touch controls. Its
  evidence is `tests/test_virtual_gamepad.py` and the device run in
  `tests/VGP-DEVICE-TEST.md`, with the two-player test as the check that
  nothing else moved.
- `netplay-streaming.js` needs the streaming end-to-end run.

Not in this stage:

- `admin.js`, the admin dashboard's controller. It is one page with no
  netplay in it and comes after the pages players use.

Staying plain JavaScript:

- `audio-worklet-processor.js` and `rollback-shadow-worker.js` run in their
  own worker contexts, where `window.KNCore` does not exist. Building them
  from TypeScript as separate entries is a change of its own, after the rest.
- `kn-state.js`, `core-redirector.js` and `api-sandbox.js` run before the
  bundle loads (`kn-state.js` is Stage 4's; its type is
  `web/src/kn-state.ts`).
- `ejs-loader.js` is EmulatorJS's loader with our boot hooks, injected by
  the page when the emulator starts. It stays in the shape of the upstream
  file it tracks.
- `netplay-lockstep.js` is a deprecated shim: a `play.html` cached from
  before the engine was renamed still asks for it, and it loads
  `netplay-rollback.js` for that page. It is deleted once those cached pages
  have expired, whatever the current pages load, and is not converted.

**Open decisions**

- `@xstate/effect` requires XState 6, which is in beta. Both are pinned to
  exact versions. Revisit when XState 6 is stable.
- The bundle is mostly Effect. It was committed at first so that deploys
  needed no Node step; with several branches changing `web/src` at once,
  every merge put the committed file in conflict with every other open
  branch. It is now build output (`web/static/dist` is git-ignored): the
  Docker image builds it in a Node stage, CI builds it, and
  `scripts/build_landing.py` / `scripts/build_demo.py` build it before
  packaging. `package-lock.json` is committed so every build gives the same
  bytes, which the landing build id depends on; CI's `image` job compares
  the image's bundles with a local build.
- The database stays on Cloudflare D1 (SQLite locally). Queries are built with
  SQLAlchemy from the model classes in `server/src/schema.py` and compiled to
  SQL for the existing backends; SQLAlchemy never opens a connection.
  All application queries are built this way; `db.query` and
  `db.execute_write` remain only for tests and one-off tooling that
  arrange data with hand-written SQL.
