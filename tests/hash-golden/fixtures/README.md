# Hash Golden Test Fixtures

Each `.rdram.gz` file is a gzipped raw 8MB dump of N64 RDRAM at a known
game state, captured directly via the WASM module's `kn_get_rdram_ptr`/
`kn_get_rdram_size` exports during a live SSB64 session. The corresponding
test loads the file (auto-decompressed by `conftest.py`) and asserts hash
bytes. If the hash registry samples a wrong address, the test fails before
the new code ever runs against a live match.

Files are gzipped because raw RDRAM is 8MB; gzipped dumps compress to ~2.5MB
(N64 RDRAM is mostly zeros + structured data).

## Capturing a fixture

In a live session with the dev server running:

1. Open `https://localhost:27888/play.html?ejs_debug=1` in a private window
2. Load SSB64 ROM (drag-and-drop or via path)
3. Navigate to the target game state
4. In the browser devtools console:
   ```js
   const ptr  = Module._kn_get_rdram_ptr();
   const size = Module._kn_get_rdram_size();
   const view = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
   const blob = new Blob([view]);
   const url  = URL.createObjectURL(blob);
   const a    = document.createElement('a');
   a.href = url; a.download = 'rdram.bin'; a.click();
   ```
5. `gzip -c rdram.bin > tests/hash-golden/fixtures/<descriptive-name>.rdram.gz`

## Fixtures

- `in-game-mid-match.rdram.gz` — raw RDRAM captured during a live SSB64
  session at game frame 3127 (originally `/tmp/rdram-guest-desync-gf3127.bin`
  from desync investigation, 2026-04-24). Used by all hash-golden tests in
  v1. Contains valid bytes at all addresses in `kn_gameplay_addrs.h`.
- `in-sudden-death.rdram.gz` — raw RDRAM during a sudden death in SSB64
  US, captured on the demo page (one emulator, the synthetic second
  player) on 2026-11-15. The battle was made a timed match with about a
  second left and both players on equal scores (game_rules, time_limit and
  time_remain written into the live battle header), so time ran out on a
  tie. Here the game's battle-state pointer (0x800A50E8) names the second
  copy, 0x800A4EF8: its game_status reads 1 and its rules stock; the live
  copy, 0x800A4D08, reads game_status 7 with the timed match's values.
