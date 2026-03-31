# About / Credits Modal

**Date:** 2026-03-31
**Status:** Approved

## Problem

kaillera-next has no "About" page or credits section. The project has a rich lineage — Kaillera (2001), EmuLinker, EmuLinker SF, EmuLinker X — and a personal origin story behind it. There's nowhere for visitors to learn about the project's history or the people who shaped it.

v0.21.0 is also a milestone: "Agent's Version," named for the creator's handle (Agent 21, inspired by Agent 47 from Hitman). This sets a precedent for dedicating future versions to contributors.

## Design

### Entry point

An "About" link in the footer of both pages, positioned between "Support" and the version badge:

```
GitHub · Support · About · v0.21.0
```

- **Lobby** (`index.html`): footer paragraph at the bottom of the page
- **Play page** (`play.html`): `.overlay-footer` in the pre-game overlay
- **Mid-game**: not accessible (toolbar stays focused on gameplay actions)

Clicking "About" opens the About modal.

### Modal layout

Same dark card as the changelog modal (`#1a1a2e` background, `#333` borders, `12px` border-radius, max-width `520px`, max-height `80vh` scrollable). A gold accent (`#c9a227`) on the title to give it personality — matching the existing Agent 21 badge style.

**Top section — Credits (always visible):**

1. Title: "kaillera-next" with gold color
2. Version dedication: "v0.21.0 — Agent's Version" (dynamic, from a lookup map)
3. Lineage block showing the project's heritage:
   - Kaillera (2001) — Christophe Thibault
   - EmuLinker — Moosehead
   - EmuLinker SF — Suprafast
   - SupraClient — Suprafast
   - n02 p2p — Jugoso, Killer Civilian
   - Project64k — Hotquik
   - AQZ NetPlay — CoderTimZ, CEnnis91
   - Ownasaurus Client — Ownasaurus
   - EmuLinker X — Near, Firo, Ownasaurus, Agent 21
   - EmuLinker-K — hopskipnfall
   - Kaillera Reborn — God-Weapon & community
   - kaillera-next — Agent 21
   - "...and the countless others who kept Kaillera alive"
4. Links: GitHub repo + Ko-fi support page

**Bottom section — "The Story" (expandable, collapsed by default):**

Same accordion pattern as changelog version entries (click header to expand/collapse, arrow indicator).

Content — a few short paragraphs in conversational tone covering:
- Grandfather's Sonic CD on a PC emulator — first encounter with emulation
- Discovering Project64 at home, finding Super Smash Bros. 64
- Finding Kaillera's netplay tab, playing SSB64 online, making friends
- The desire to fix the problems with the emulator/server/client — but being only 9-12 years old
- Getting involved with the community, eventually moving on but never forgetting
- Now, finally building the fix

**Interactions:**
- Close via × button, backdrop click, or Escape key (same as changelog modal)

### Version dedications

A static map in `version.js`:

```js
const VERSION_DEDICATIONS = {
  '0.21.0': "Agent's Version",
};
```

If the current version has an entry, the dedication line shows `vX.Y.Z — <name>`. Otherwise it's omitted. Future versions can be added to the map as the tradition grows.

## Files to modify

- `web/static/version.js` — add `showAbout()` function and `VERSION_DEDICATIONS` map; wire up click handler for About links
- `web/index.html` — add "About" link in footer (between Support and version badge)
- `web/play.html` — add "About" link in `.overlay-footer` (between Support and version badge)

## Validation

- Visual check on desktop and mobile (lobby + play page pre-game)
- Verify About link doesn't appear mid-game
- Verify expandable story section works
- Verify dedication line shows for v0.21.0 and is absent for unlisted versions
