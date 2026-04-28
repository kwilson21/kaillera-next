# Vendored Assets

Single source of truth for every third-party file checked into this repo.
Update this file whenever you re-import, replace, or remove a vendored asset.

Last updated: 2026-04-27

---

## Frontend (`web/static/`)

### `socket.io.min.js`
- **Version:** 4.8.3
- **Source:** https://github.com/socketio/socket.io-client (banner inside file)
- **Used by:** all pages — Socket.IO client
- **Pairs with:** server `python-socketio 5.16.x` (compatible with v4 protocol)

### `vendor/fflate.min.js`
- **Version:** unknown — banner was stripped before import
- **Source:** https://github.com/101arrowz/fflate
- **First imported:** commit `74ecaba` ("harden security, add Pydantic validation, dedup WebRTC, adopt fflate")
- **Used by:** `play.js` (`fflate.unzipSync` for ROM `.zip` extraction)
- **TODO:** at next opportunity, replace with a tagged upstream release and record version + SHA here.

### `ejs/emulator.min.js` + `ejs/emulator.min.css`
- **Version:** 4.2.3 (also recorded in `ejs/version.json`)
- **Source:** kaillera-next fork of https://github.com/EmulatorJS/EmulatorJS
- **Notes:** patched core redirector logic lives in `core-redirector.js`; the EJS bundle
  itself is upstream + minor patches.

### `ejs/cores/mupen64plus_next_libretro.{js,wasm}` + `mupen64plus_next-wasm.data`
- **Version:** built locally by `build/build.sh` — see "Build sources" below for pinned SHAs
- **Patches applied:** see Stage 2 in `build/build.sh` (deterministic timing, SoftFloat FPU,
  rollback exports, RSP audio skip, sync v3, hidden-state fingerprint)
- **`ejs/build.json`:** records `{minimumEJSVersion, version}` for the packaged core data file

### `ejs/compression/{extract7z.js, extractzip.js, libunrar.{js,wasm}}`
- **Version:** ships with EJS 4.2.3 — covered by the EJS entry above

### `ejs/localization/*.json`
- **Version:** ships with EJS 4.2.3 — covered by the EJS entry above

---

## Build sources (`build/src/`, cloned at build time)

These are not checked into the repo, but `build/build.sh` clones them on first build.
SHAs below are the versions the current shipped WASM core was built against —
keep these pinned so future builds are reproducible.

### `mupen64plus-libretro-nx`
- **Repo:** https://github.com/EmulatorJS/mupen64plus-libretro-nx
- **Branch:** `develop`
- **Pinned SHA:** `4a3925d2861f17719586dffb178c1dd5339d3a68`
- **HEAD message:** `Merge branch 'libretro:develop' into develop`

### `RetroArch`
- **Repo:** https://github.com/EmulatorJS/RetroArch
- **Branch:** `next`
- **Pinned SHA:** `ed3265745eccec99b48f99e2a2ffc8a6a93823bb`
- **HEAD message:** `Add ability to get pointer to emulated ram`

To bump: update the SHA in `build/build.sh`, rebuild, and update both this file and
the new SHA here in one commit.

---

## Out-of-scope (not used on `main`)

### `web/webgpu-pivot-test/vendor/naga/`
- Smash64r experimental sandbox (WebGPU shader conversion). Not loaded by any page on
  the main netplay path. Tracked on the `smash64r` branch — record version there if
  it gets promoted to production.

### `build/recomp/vendor/`
- Smash64r recompilation work-in-progress (gliden64, smash64r, etc.). Not part of the
  shipping browser app; lives on the `smash64r` branch.
