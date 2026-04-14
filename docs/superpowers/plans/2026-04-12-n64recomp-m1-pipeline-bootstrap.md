# N64Recomp M1: Pipeline Bootstrap — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the N64Recomp build pipeline locally, produce compilable C output from the vanilla SSB64 ROM with a complete overlay map, and commit a reproducible configuration that subsequent milestones (M2+) can build on.

**Architecture:** Add N64Recomp as a local build tool (Phase 1 per spec — manual, not yet in Docker). Generated C lives in `build/recomp/ssb64-u/` (git-committed artifact for Phase 1). Overlay configuration in `build/recomp/ssb64-u/config.toml`. Supporting overlay-mapping documentation in `docs/n64recomp-overlay-map.md`.

**Tech Stack:** N64Recomp (Rust binary from Mr-Wiseguy/N64Recomp), TOML configs, Python for ROM hash verification, bash for build scripts.

**Out of scope for this plan:** WASM build integration (M2), shim layer (M3), boot handoff (M4), Smash Remix variant (M6). M1's only deliverable is "given the vanilla SSB64 ROM, produce compilable C and a committed overlay map."

**Spec reference:** [docs/superpowers/specs/2026-04-12-n64recomp-integration-design.md](../specs/2026-04-12-n64recomp-integration-design.md)

---

## Chunk 1: N64Recomp Tool Setup

This chunk gets N64Recomp building and verified against its own reference ROM (Zelda MM/OOT). We're proving the tool works on our machine before we point it at SSB64.

### Task 1: Clone and build N64Recomp locally

**Files:**
- Create: `build/recomp-tool/` (gitignored clone of N64Recomp repo)
- Modify: `.gitignore`
- Create: `build/recomp/README.md`

- [ ] **Step 1: Add `.gitignore` entry for the tool clone**

Edit `.gitignore`, add:
```
# N64Recomp tool checkout (not committed; rebuild from source)
build/recomp-tool/
```

- [ ] **Step 2: Clone N64Recomp**

```bash
mkdir -p build
git clone https://github.com/Mr-Wiseguy/N64Recomp.git build/recomp-tool
```

Expected: clone succeeds. If the repo has been renamed or moved, check https://github.com/Mr-Wiseguy for the current location before proceeding.

- [ ] **Step 3: Build N64Recomp with cargo**

```bash
cd build/recomp-tool && cargo build --release
```

Expected: builds without error. Produces `build/recomp-tool/target/release/N64Recomp` (or similar binary name — check the repo's README for the exact name).

If cargo is not installed, install it via rustup (https://rustup.rs) first. Document the installation in `build/recomp/README.md`.

- [ ] **Step 4: Verify the binary runs**

```bash
./build/recomp-tool/target/release/N64Recomp --help
```

Expected: prints usage information. Note the exact CLI surface (flags, required arguments) — this informs Task 4.

- [ ] **Step 5: Write the README for this directory**

Create `build/recomp/README.md` documenting:
- What this directory is (generated C from N64Recomp)
- How to regenerate (rough steps, refined at end of plan)
- Why the tool checkout is gitignored but generated C is committed (Phase 1 per spec)

- [ ] **Step 6: Commit**

```bash
git add .gitignore build/recomp/README.md
git commit -m "chore(recomp): add N64Recomp tool bootstrap"
```

### Task 2: Verify N64Recomp works against a known-good reference

We don't want to discover we're misusing the tool when debugging our own config. Run it once against a reference that's known to work.

**Files:**
- Create: `build/recomp/REFERENCE_VERIFICATION.md`

- [ ] **Step 1: Find a public reference config**

Search the N64Recomp repo (`build/recomp-tool/`) for example configs or a `examples/` directory. The Zelda 64: Recompiled project published its config publicly — if no example in the tool repo, find it at https://github.com/Zelda64Recomp/Zelda64Recompiled (or via the tool's README link).

- [ ] **Step 2: If a reference ROM is available, run the reference config**

**Strongly preferred if a reference ROM is on hand.** Confirming the tool works against a known-good input de-risks Task 4 — if SSB64 fails there, we'll know it's our config and not the tool. Skip only if no reference ROM is reachable.

- [ ] **Step 3: Document verification outcome**

Write `build/recomp/REFERENCE_VERIFICATION.md`:
- Was reference verified? If yes, what was the output format (file naming, directory structure, function-per-file vs per-section).
- If skipped, note: "Reference verification skipped; proceed with SSB64 and debug via tool error output."

- [ ] **Step 4: Commit**

```bash
git add build/recomp/REFERENCE_VERIFICATION.md
git commit -m "docs(recomp): reference verification notes"
```

---

## Chunk 2: SSB64 ROM Configuration

This chunk writes the TOML config that tells N64Recomp how to process the vanilla SSB64 ROM. This is where the real exploratory work happens — nobody has published an SSB64 config for N64Recomp before.

### Task 3: Stand up the per-ROM output directory and ROM verification

**Files:**
- Create: `build/recomp/ssb64-u/README.md`
- Create: `build/recomp/ssb64-u/verify_rom.py`
- Create: `build/recomp/ssb64-u/.gitignore`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p build/recomp/ssb64-u
```

- [ ] **Step 2: Write ROM hash verification script**

`build/recomp/ssb64-u/verify_rom.py`:

```python
#!/usr/bin/env python3
"""Verify the SSB64 (U) ROM has the expected hash before running N64Recomp.

Refuses to run N64Recomp if the hash does not match, so we don't silently
generate C from a different revision or a byte-swapped copy.
"""
import hashlib
import sys
from pathlib import Path

# SSB64 (U) [!] — big-endian Z64 format
# Source: redump.org / memory/reference_rom_path.md
# If you have a .v64 (byte-swapped) ROM, convert to .z64 first — the swapped
# ROM will NOT match this hash and N64Recomp expects big-endian.
EXPECTED_SHA1 = "5be5ef5fc4f2a775e2ce6b4ebff47842b66fbcb5"  # verify against your copy

def main(rom_path: str) -> int:
    path = Path(rom_path)
    if not path.exists():
        print(f"ROM not found: {rom_path}", file=sys.stderr)
        return 2

    sha1 = hashlib.sha1(path.read_bytes()).hexdigest()
    if sha1 != EXPECTED_SHA1:
        print(f"ROM hash mismatch.", file=sys.stderr)
        print(f"  expected: {EXPECTED_SHA1}", file=sys.stderr)
        print(f"  got:      {sha1}", file=sys.stderr)
        print(f"  If your ROM is .v64 (byte-swapped), convert to .z64 first.", file=sys.stderr)
        return 1

    print(f"ROM hash OK: {sha1}")
    return 0

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} <path-to-ssb64.z64>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
```

- [ ] **Step 3: Confirm the expected hash**

The `EXPECTED_SHA1` above is a placeholder. Before committing, compute the hash of the actual SSB64 (U) ROM you'll build against and replace it. The user's memory `reference_rom_path.md` points to the canonical ROM location.

```bash
sha1sum /path/to/ssb64-u.z64
```

Edit `verify_rom.py` with the correct value.

- [ ] **Step 4: Test the script**

```bash
python3 build/recomp/ssb64-u/verify_rom.py /path/to/ssb64-u.z64
```

Expected: `ROM hash OK: <hash>`

Then test failure mode:

```bash
python3 build/recomp/ssb64-u/verify_rom.py /dev/null
```

Expected: exit code 1 with a hash mismatch message.

- [ ] **Step 5: Write directory README and gitignore**

`build/recomp/ssb64-u/.gitignore`:
```
# ROM is never committed (copyright) — point verify_rom.py at your local copy.
*.z64
*.n64
*.v64
```

`build/recomp/ssb64-u/README.md`:
```markdown
# SSB64 (U) N64Recomp output

Generated C for the vanilla SSB64 (U) ROM.

## Regenerate

    python3 verify_rom.py /path/to/ssb64-u.z64
    ../../recomp-tool/target/release/N64Recomp config.toml

Config: [config.toml](config.toml)
Overlay map rationale: [../../../docs/n64recomp-overlay-map.md](../../../docs/n64recomp-overlay-map.md)
```

- [ ] **Step 6: Commit**

```bash
git add build/recomp/ssb64-u/README.md build/recomp/ssb64-u/verify_rom.py build/recomp/ssb64-u/.gitignore
git commit -m "chore(recomp): SSB64 (U) output directory and ROM verification"
```

### Task 4: Write a minimal boot-only config and run N64Recomp

This is the first run. We don't declare any overlays yet — just enough config to get N64Recomp to accept the ROM and output the root/boot code. Expect the output to be incomplete; that's fine. The goal is to prove the tool-to-ROM pipeline works.

**Files:**
- Create: `build/recomp/ssb64-u/config.toml` (initial boot-only version)

- [ ] **Step 1: Read N64Recomp config format**

Open `build/recomp-tool/README.md` and any `docs/` in the tool repo. Enumerate the required top-level TOML keys (likely: ROM path, ROM metadata, root section, optional overlays list).

If the tool has an `--example-config` flag or ships an example TOML in its repo, prefer that as a starting point.

- [ ] **Step 2: Write the boot-only config**

`build/recomp/ssb64-u/config.toml`:

```toml
# Initial boot-only config — does NOT declare overlays yet (Task 6 adds those).
# This exists to verify N64Recomp accepts the ROM and produces SOME output.
# Expect warnings about unreachable code / missing overlay sections.

# Fill in exact keys based on build/recomp-tool/README.md conventions.
# If the schema differs from what's below, update it to match.

[input]
rom = "/path/to/ssb64-u.z64"  # caller provides absolute path
entrypoint_address = 0x80000400  # N64 convention; verify from ROM header

[output]
output_dir = "."
```

Leave `rom` as a placeholder; callers pass `--input` at the CLI or override the path. Do NOT commit a hard-coded local path.

- [ ] **Step 3: Run N64Recomp with the minimal config**

```bash
cd build/recomp/ssb64-u
../../recomp-tool/target/release/N64Recomp config.toml --input /path/to/ssb64-u.z64
```

Expected behavior: one of three outcomes.

1. **Success with warnings** — the tool emits C files but warns about unmapped code / unresolved jumps. This is the desired outcome. Proceed to Step 4.
2. **Hard failure requesting overlay config** — tool refuses to proceed without overlay declarations. In that case, it has told us exactly what it needs; document the error in `REFERENCE_VERIFICATION.md` and proceed to Task 5 without Step 4.
3. **Unexpected failure (malformed config, missing key)** — iterate on the config until outcome 1 or 2. Fix the config; do not modify the ROM or the tool.

- [ ] **Step 4: If output was produced, document what came out**

Run `ls build/recomp/ssb64-u/` and note:
- How many `.c` files were produced?
- Are functions grouped per-file or per-section?
- What headers does the generated code `#include`?

This informs the shim design (M3) and the build integration (M2).

Append findings to `build/recomp/ssb64-u/README.md`.

- [ ] **Step 5: Commit the config (do not commit generated C yet)**

Generated C gets committed in Task 6, once the config is complete. At this stage, the config is WIP.

```bash
git add build/recomp/ssb64-u/config.toml build/recomp/ssb64-u/README.md
git commit -m "wip(recomp): initial boot-only SSB64 config"
```

### Task 5: Enumerate SSB64 overlays

Build an overlay map from available sources (Smash Remix source, ssb-decomp-re references, runtime logging). This is the most uncertain task in the plan. Budget 2-3 days; it could be half a day if the Smash Remix source is well-documented or 4+ days if we need to do runtime analysis.

**Timebox checkpoint:** After 1 day on Steps 1-2, if overlay coverage is below ~50% (significantly incomplete map relative to known game modes: boot, CSS, stage select, VS match, results, menus), stop and escalate to the user before committing to the runtime-logging path in Step 4. Runtime logging requires patching mupen64plus-next and is a significant scope expansion — the user should decide whether to proceed or reconsider M1 scope.

**Files:**
- Create: `docs/n64recomp-overlay-map.md`

- [ ] **Step 1: Grep the Smash Remix source for overlay loads**

```bash
grep -rn "overlay" build/src/smashremix/src/ | head -50
grep -rn "0x8[0-9a-f]\{7\}" build/src/smashremix/src/Global.asm | head -50
```

Look for: load-overlay functions, overlay tables, "seg" symbols, macros like `OverlayLoad` or similar. Smash Remix inherits SSB64's overlay system.

- [ ] **Step 2: Check ssb-decomp-re for overlay info**

Memory `kn_rollback.c` references ssb-decomp-re. Search GitHub (via `gh` CLI if available, or WebFetch) for the repo:

```bash
gh search repos ssb-decomp-re --limit 5
```

Clone it to `/tmp/` (not into this repo) and grep for overlay references:

```bash
git clone https://github.com/<owner>/ssb-decomp-re /tmp/ssb-decomp-re
grep -rn "overlay\|OVERLAY" /tmp/ssb-decomp-re/include /tmp/ssb-decomp-re/src | head -50
```

- [ ] **Step 3: Write the overlay map**

`docs/n64recomp-overlay-map.md`:

```markdown
# SSB64 (U) Overlay Map

Assembled from:
- [Smash Remix source](../build/src/smashremix/src/)
- ssb-decomp-re (external reference)
- Runtime analysis (if needed)

## Overlays

| Name | ROM offset | RAM address | Size | Purpose | Source |
|---|---|---|---|---|---|
| main | 0x1000 | 0x80000400 | ... | Boot + main loop | ROM header |
| ... | ... | ... | ... | ... | ... |

## Known unknowns

- [list anything we couldn't find a source for]
```

Fill in the table as entries are confirmed. If an overlay is mentioned but its size or load address isn't confirmed, mark it `?` and note the source uncertainty.

- [ ] **Step 4: If static sources are insufficient, add runtime logging**

Fallback: modify mupen64plus-next to log every code-address write (DMA from ROM to RAM in the code range) while booting SSB64. This gives an empirical overlay table.

If you need to go this route, add a temporary patch to `build/patches/` that logs `dma_pi_read` calls with source ROM offset and destination RAM address. Run a full boot and write-every-stage session. Extract the unique (src, dst, size) tuples. This is a last-resort task — try Steps 1-2 thoroughly first.

- [ ] **Step 5: Commit the overlay map**

```bash
git add docs/n64recomp-overlay-map.md
git commit -m "docs(recomp): SSB64 (U) overlay map"
```

### Task 6: Complete the config and produce the final generated C

**Files:**
- Modify: `build/recomp/ssb64-u/config.toml`
- Create: `build/recomp/ssb64-u/generated/` (many `.c` and `.h` files — exact naming from N64Recomp output)

- [ ] **Step 1: Translate the overlay map into TOML**

Edit `config.toml`. Add an overlays section per the N64Recomp schema (check tool README for exact key names — likely `[[overlays]]` with `rom_offset`, `ram_address`, `size`, `name`).

For each overlay in the map, add a TOML entry. Use the name from the map as the TOML name field.

- [ ] **Step 2: Run N64Recomp with the full config**

```bash
python3 build/recomp/ssb64-u/verify_rom.py /path/to/ssb64-u.z64 && \
cd build/recomp/ssb64-u && \
../../recomp-tool/target/release/N64Recomp config.toml --input /path/to/ssb64-u.z64
```

Expected: produces C files in `build/recomp/ssb64-u/generated/` (or wherever the config says). Warnings are acceptable; hard errors are not.

- [ ] **Step 3: Sanity check function count**

```bash
grep -rc "^[a-zA-Z_][a-zA-Z0-9_]* *(.*) *{" build/recomp/ssb64-u/generated/ | awk -F: '{s+=$2} END {print s}'
```

Expected: thousands of functions (SSB64 has ~10k-15k functions per typical decomp analysis). If you get fewer than 1000, overlays are likely missing from the config.

Document the count in `build/recomp/ssb64-u/README.md`.

- [ ] **Step 4: Sanity check compilation of ONE function**

Grab one generated `.c` file and try to compile it in isolation. It will fail to link (undefined runtime symbols) — but it should not fail to parse or type-check.

```bash
emcc -c build/recomp/ssb64-u/generated/<some_file>.c -o /tmp/test.o \
     -I build/recomp/ssb64-u/generated/ \
     -I build/recomp-tool/include/ \
     2>&1 | head -30
```

Expected: either (a) compiles to `.o` with "unresolved external" warnings at link time (good — proves parse success), or (b) hard compile errors indicating the generated code uses headers/intrinsics we haven't stubbed yet.

If (b), note the missing headers/macros in `build/recomp/ssb64-u/README.md`. These become the shim's public header surface (M3 input).

- [ ] **Step 5: Commit generated C**

Generated C is committed as an artifact in Phase 1 (spec §Build Pipeline). It's bulky but reproducible:

```bash
git add build/recomp/ssb64-u/config.toml build/recomp/ssb64-u/generated/ build/recomp/ssb64-u/README.md
git commit -m "feat(recomp): generate SSB64 (U) C from N64Recomp"
```

If the generated output exceeds a reasonable commit size (e.g., >100MB), stop and talk to the user before proceeding. Options then: git-lfs, or move generated output to an artifact store and regenerate in Docker (skip ahead to Phase 2).

---

## Chunk 3: M1 Exit — Reproducibility

Lock in the reproducibility story before calling M1 done. Anyone on the team should be able to regenerate the output from scratch.

### Task 7: Top-level regeneration script

**Files:**
- Create: `build/recomp/regenerate.sh`

- [ ] **Step 1: Write the regeneration script**

`build/recomp/regenerate.sh`:

```bash
#!/usr/bin/env bash
# Regenerate the N64Recomp C output for a given ROM.
# Usage: ./regenerate.sh <rom-variant> <path-to-rom>
#   rom-variant: ssb64-u (more added in later milestones, e.g. smashremix-<ver>)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VARIANT="${1:-}"
ROM="${2:-}"

if [[ -z "$VARIANT" || -z "$ROM" ]]; then
    echo "usage: $0 <rom-variant> <path-to-rom>" >&2
    echo "  rom-variant: ssb64-u" >&2
    exit 2
fi

VARIANT_DIR="${SCRIPT_DIR}/${VARIANT}"
if [[ ! -d "$VARIANT_DIR" ]]; then
    echo "unknown variant: $VARIANT (no directory at $VARIANT_DIR)" >&2
    exit 2
fi

# Verify ROM hash before touching anything
python3 "${VARIANT_DIR}/verify_rom.py" "$ROM"

# Build the tool if not already built
if [[ ! -x "${SCRIPT_DIR}/../recomp-tool/target/release/N64Recomp" ]]; then
    echo "Building N64Recomp..." >&2
    (cd "${SCRIPT_DIR}/../recomp-tool" && cargo build --release)
fi

# Regenerate
cd "$VARIANT_DIR"
"${SCRIPT_DIR}/../recomp-tool/target/release/N64Recomp" config.toml --input "$ROM"

echo "Regenerated C in ${VARIANT_DIR}/generated/"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x build/recomp/regenerate.sh
```

- [ ] **Step 3: Test the script**

```bash
./build/recomp/regenerate.sh ssb64-u /path/to/ssb64-u.z64
```

Expected: outputs match the C files committed in Task 6. Spot-check one or two files for byte-identical regeneration.

- [ ] **Step 4: Test failure modes**

```bash
./build/recomp/regenerate.sh  # no args → usage
./build/recomp/regenerate.sh bogus /path/to/rom  # unknown variant
./build/recomp/regenerate.sh ssb64-u /dev/null  # bad ROM
```

Each should fail loudly with a clear message.

- [ ] **Step 5: Commit**

```bash
git add build/recomp/regenerate.sh
git commit -m "chore(recomp): regenerate.sh entry point"
```

### Task 8: Update the main project README / CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Possibly modify: `CLAUDE.md` (add build/recomp/ to repo structure)

- [ ] **Step 1: Add CHANGELOG entry**

Append to `CHANGELOG.md` under the next unreleased version:

```markdown
### Added
- N64Recomp build pipeline bootstrap (M1). Generates compilable C from
  vanilla SSB64 (U) ROM. Not yet integrated into the WASM build — M2
  covers integration. See docs/superpowers/specs/2026-04-12-n64recomp-integration-design.md.
```

- [ ] **Step 2: Update CLAUDE.md repo structure diagram**

Open `CLAUDE.md`, find the repo structure diagram, add:

```
├── build/
│   ├── recomp/              # N64Recomp configs + generated C (Phase 1)
│   │   └── ssb64-u/         # per-ROM-variant output
│   └── recomp-tool/         # gitignored N64Recomp tool checkout
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "docs: note N64Recomp M1 pipeline in changelog and CLAUDE.md"
```

---

## M1 Exit Criteria

M1 is done when:

- [ ] `build/recomp/regenerate.sh ssb64-u /path/to/rom` produces generated C without errors
- [ ] Generated C contains >1000 functions (plausibility check)
- [ ] One sample `.c` file compiles under `emcc` (may have unresolved externs at link time — that's expected)
- [ ] `docs/n64recomp-overlay-map.md` lists all overlays with sources
- [ ] Config + overlay map + generated C are committed
- [ ] CHANGELOG and CLAUDE.md reflect the new pipeline

**Known unknowns surfaced by M1** (inputs to M2 planning):
- Exact N64Recomp runtime API surface (what shim needs to implement)
- How the generated C wants to be linked (one object per file? unity build? include-as-source?)
- Which overlays, if any, resisted static analysis and need runtime-analysis fallbacks

These are documented at the bottom of `build/recomp/ssb64-u/README.md` as an M2 planning input.

---

## Plan Scope Note

M1 only. M2 (WASM build integration) will be planned after M1 completes and we have concrete information about:
1. The generated C's structure
2. The N64Recomp runtime API surface
3. Any missing headers / macros that block compilation

Writing M2-M8 upfront would be speculation. Plan → learn → plan is the right cadence for this exploratory phase.
