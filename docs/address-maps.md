# Address maps for the desync detector

The desync detector compares a few pieces of game state between peers,
frame by frame: stock counts, the scene, the RNG seed, the character-select
state, the fighter structs. The core's hash registry
(`build/kn_rollback/kn_hash_registry.c`) reads them straight out of the
game's RAM, so it has to be told where they are, and that is different in
every game. A ROM's set of addresses is its **address map**.

Maps are data. `web/src/address-maps.ts` holds one per ROM, keyed by the ROM
hash the page computes. At the start of a match the page looks its ROM up
(`KNCore.addressMapFor`) and the detector installs the map in the core
(`kn_field_map_set`). A ROM with no map gets no detector, and the sync log
says `KNDesync off: no field address map for this ROM`. Adding a ROM does not
need a core rebuild.

Under a wrong map nothing crashes. The fields are then hashes of unrelated
memory under SSB64's names: missed desyncs if that memory never differs,
false flags if it legitimately does (audio and framebuffer memory differ
between healthy peers). So a map goes in only after it has passed every
step below.

## What a map contains

`AddressMap` in `web/src/address-maps.ts`, in the order of the `KN_MAP_*`
enum in `build/kn_rollback/kn_hash_registry.h`. Offsets are N64 RDRAM
offsets (the address with the top byte dropped). One-byte fields (stock
counts, the scene) are given by their N64 address; the registry applies the
byte swap. With the map come the ROM's scene numbers for the character
select, the stage select and the battle, which the detector uses to decide
which fields mean anything in a given frame.

## Adding a ROM

1. **Find the addresses, and say where each came from.** A decompilation or
   a symbol map is the source; cite file and line in a comment on the map,
   as `kn_hash_registry.h` does for SSB64 US. An address found by searching
   RAM is a guess until the steps below say otherwise, and a comment should
   say that too.

2. **Add the map** to `ROM_ADDRESSES` under the ROM's hash (the page logs
   it; `server/config/known_roms.json` lists the known ones).
   `tests/ts/address-maps.test.ts` then checks the registry would accept it.

3. **Check it against the running game.** With the ROM:

   ```bash
   KN_ROM=/path/rom.z64 LAT=50 JITTER=20 ADDRESS_MAP_CHECK=1 node tests/rb-two-player.mjs
   ```

   Every 30 frames each page reads the map's fields from RAM, and the run
   fails unless, on both peers, the scene byte read the character select and
   then the battle, the character ids are the fighters picked, stock counts
   are plausible, the battle header is not empty, the RNG seed moves and the
   fighter-buffer pointer, once set, points into RAM. The checks and what they read are
   printed, and written to `summary.json` as `addressMapCheck`.

   Before the map is in the table, try a candidate that is: add it under a
   scratch key and pass that key as `ADDRESS_MAP_OF=<hash>`, which also runs
   the detector with it (`?desync=force&desyncMap=`). If the ROM's menus are
   not laid out like SSB64's, add `MENU_AUTOPILOT=any-fighter`.

4. **A healthy match raises no flag.** The same run must end with zero hash
   mismatches and no `KNDesync suspect` line in either peer's sync log.
   This is the check that catches an address in memory that differs between
   healthy peers. Run it more than once, and at `JITTER=20` so there are
   rollbacks: a field that only disagrees in a mispredicted frame shows up
   here.

5. **A real desync is flagged.**

   ```bash
   KN_ROM=/path/rom.z64 LAT=50 JITTER=20 DESYNC_GUEST=1 node tests/rb-two-player.mjs
   ```

   changes P1's stock count on one peer through the map's address and
   passes only if both peers flag `stocks` for slot 0 afterwards and nothing
   before.

6. **Keep a RAM dump as a fixture** (`tests/hash-golden/fixtures/README.md`
   says how to take one) with a test in `tests/hash-golden` that the map's
   addresses read the values the dump was taken at: the scene number, the
   stock counts on screen. That is what keeps the map right when someone
   edits it later.

## What these steps do not show

- Step 3 shows the addresses hold values of the right kind at the right
  time. It cannot tell a stock count from another small counter that
  happens to sit in range.
- Steps 4 and 5 exercise two players, one stage, about a minute of play.
  Memory that only differs in a four-player match, or on another stage, is
  not covered.
- Only `stocks` is injected in step 5. The other fields are shown to stay
  quiet when healthy, not to fire when wrong.
- A ROM hack's addresses can move between its releases. Each release is its
  own ROM hash and needs its own run of these steps; a map is never assumed
  to carry over.
