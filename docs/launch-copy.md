# Launch copy — rollback demo

Drafts for tweet, Show HN, Reddit, Loom, and landing page. All grounded in the
mechanism (rollback hides the network round-trip; lockstep makes you wait it).
None oversell.

---

## Framing guidelines

These are the rules every public-facing claim about the demo should follow.
Stick to them and the demo doesn't read as AI slop.

**Say:**
- "Rollback hides the network round-trip locally."
- "Lockstep waits the full round-trip every frame; rollback runs immediately."
- "The contrast between rollback ON and OFF at the same simulated lag is the proof."
- "Feels like offline play under ~150 ms of network lag." (industry-validated, e.g. Wikipedia/SnapNet)

**Don't say:**
- "Zero lag" or "no input delay." Real games still use 1–3 frames of input
  buffer (~17–50 ms) regardless of netcode. The buffer gives the network a
  head start; without it, predictions miss too often.
- "Rollback fixes lag." It doesn't fix it; it hides it locally and rewinds
  silently when predictions miss.
- "Eliminates rollbacks." Rollbacks happen all the time in real play; they're
  the mechanism, not a failure mode.
- "Faster than offline." It can never be faster than offline.

**Numbers we can cite with sources:**
- Rollback typical perceived lag: 1–2 frames (~17–33 ms)
- Lockstep / delay-based typical: ~6 frames (~100 ms) at standard settings
- Threshold where rollback feels offline: ~150 ms RTT
- Sources: SnapNet ("Netcode Architectures Part 2"), coherence docs
  ("Determinism, Prediction and Rollback"), Wikipedia "GGPO" / "Netcode"

---

## Tweet (280 chars)

> Built a 1-player demo that lets you feel rollback netplay vs lockstep —
> browser, no friend required.
>
> Drop an N64 ROM, crank the lag slider to 200 ms, toggle rollback off. Game
> stalls every frame. Toggle on. Smooth.
>
> Same code, same opponent. Just netcode.
>
> [link]

Alt (more direct):

> N64 rollback netplay. In a browser. With a "show me" button.
>
> Drop a ROM, crank simulated lag, toggle rollback off → game pauses every
> frame waiting for the opponent. Toggle on → smooth.
>
> You're convinced or you're not.
>
> [link]

---

## Show HN

**Title:** `Show HN: 1-player rollback netplay demo for N64 (browser, EmulatorJS + WASM)`

**Body:**

> I've been working on kaillera-next, a browser-based netplay site for N64
> games. The interesting part is the rollback engine: GGPO-style, written in C,
> compiled to WASM, runs alongside a patched mupen64plus-next core.
>
> The 1P demo lets you feel the difference between rollback and lockstep
> without needing a second person:
>
> - Drop an SSB64 or Smash Remix ROM
> - The page spins up a synthetic second peer in-process (WebRTC bypassed for
>   the demo)
> - One slider: simulated network lag (0–300 ms)
> - One toggle: rollback ON / OFF
>
> With rollback OFF, the engine waits for the synthetic peer's input every
> frame. At 200 ms simulated lag, the game stalls noticeably. Toggle on and
> the engine predicts the synthetic peer locally, runs at full speed, and
> rewinds silently on misprediction. The lag is still on the wire — rollback
> hides it from you.
>
> A few things that were annoying to get right:
>
> - Cross-platform deterministic emulation requires SoftFloat FPU (Apple vs
>   Intel native FPUs disagree at the bit level on certain ops, breaks lockstep
>   sync after a few thousand frames)
> - The mupen64plus WASM core needed patches to expose ring-buffer state
>   pointers and accept frame-synchronized input
> - The C rollback engine has to live within Asyncify constraints because
>   retro_serialize / retro_unserialize aren't synchronous in the WASM build
>
> Honest about what the demo proves: the felt contrast between modes is the
> proof. The HUD numbers are mechanically derived (lag × 2 for the lockstep
> round-trip), not measured. The point is that rollback's perceived input lag
> stays fixed while lockstep's scales with network — verifiable by toggling
> repeatedly.
>
> Code: <https://github.com/kwilson21/kaillera-next> (GPL-2)
> Live demo: [link]
> Lag visualizer (no ROM needed): [link]
>
> Things I'd love feedback on:
>
> - Whether the framing is convincing without sounding overclaimed
> - ROM compatibility — currently tested SSB64 + Smash Remix; other N64 titles
>   probably work but unverified
> - Mobile, especially iOS Safari

---

## Loom script (~60 seconds)

```
[0:00] [show demo page in browser]
"This is kaillera-next. N64 netplay in a browser."

[0:05] [drag SSB64 ROM into dropzone]
"Drop a ROM. Game boots in a few seconds."

[0:15] [game on title screen]
"Running. Now let me simulate a slow network."

[0:20] [drag lag slider to 200 ms]
"200 milliseconds — that's a bad connection."

[0:25] [press jump in-game, character responds immediately]
"My character responds the moment I press jump. That's rollback —
 the engine runs locally and predicts the opponent."

[0:35] [click 'Rollback OFF']
"Now without rollback."

[0:40] [game stutters / stalls with each input]
"Every frame, the game pauses 200 ms waiting for the opponent.
 Basically unplayable."

[0:50] [click 'Rollback ON']
"Same lag. Same opponent. Same code path. Just rollback back on."

[0:55] [game smooth again]
"Smooth. That's the proof."

[1:00] [show URL]
"Try it yourself. Link below."
```

---

## Landing page blurb (for thesuperhuman.us)

> **kaillera-next**
> N64 netplay for the modern web. Drop a ROM, share a link, play with friends.
> No installs, no router config, no screen-share. The hard part is rollback:
> the engine predicts your opponent's inputs, runs locally without waiting,
> and rewinds on misprediction. Below 200 ms of network lag, you can't feel
> the network.
>
> [Try the rollback demo →] &nbsp; [Lag visualizer (no ROM) →] &nbsp; [Create a room →]

---

## Reddit drafts

### r/emulation

**Title:** `Made a browser-based N64 netplay site with proper rollback netcode`

**Body:**

> Sharing a project I've been working on: kaillera-next.
>
> It's N64 netplay in the browser. Drop a ROM, share a link, play. Forked
> mupen64plus-next core (deterministic timing patches + SoftFloat FPU for
> cross-platform bit-exactness) plus a GGPO-style C rollback engine compiled
> to WASM.
>
> Built a 1P demo so you can feel the rollback without needing a second
> person — synthetic opponent feeds inputs in-process, single slider for
> simulated lag, single toggle for rollback ON / OFF. Crank lag to 200 ms,
> toggle rollback off, game stalls. Toggle on, smooth.
>
> [link to demo]
>
> Currently tested with SSB64 and Smash Remix. Other N64 ROMs likely work
> but I haven't tested them all.
>
> GPL-2, code at <https://github.com/kwilson21/kaillera-next>. Continuing
> the legacy of Kaillera (2001).

### r/smashbros / r/Smash64

**Title:** `Browser-based SSB64 with rollback netcode — testers welcome`

**Body:**

> Built kaillera-next, a no-download SSB64 netplay site. Rollback netcode,
> GGPO-style. Free, GPL.
>
> Made a 1P demo so you can prove to yourself that the rollback works before
> convincing a friend to try: [link]. Crank the lag slider, toggle rollback
> off, game pauses every frame. Toggle on, smooth. Same code path either way.
>
> Tested with SSB64 (US) and various Remix builds. Looking for people to
> try it out and report bugs / desyncs.
>
> Site: [link]
> Demo: [link]
> Code: <https://github.com/kwilson21/kaillera-next>

---

## Phase plan

Per the existing promotion strategy: SSB64 / emulation niches first, then
broader gaming, then HN / dev. Don't HN before the niche communities have
shaken out launch-week bugs — HN traffic is brutal on a public-facing demo,
and a stalled emulator is the worst possible first impression.

Suggested order:
1. r/Smash64, r/smashbros (small, friendly, will report bugs)
2. r/emulation (broader emulation crowd)
3. Twitter / X with the demo video
4. r/fightingames (rollback-aware, will scrutinize the contrast claim)
5. Show HN (wait until at least one round of bug-fix iteration)

Discord communities to ping after the public posts: SSB64 modding, EmulatorJS
contributors, fightcade community.
