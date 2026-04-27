## Issues
1. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:97](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:97) — fabricated symbol `kn_um_get_swap_count` — no match in `feat/smash64r-wasm:build/kn_recomp/*`; closest real exported counters are `kn_fiber_get_drive_frame_calls` and `kn_fiber_get_switches` at `build/kn_recomp/kn_recomp_shim.c:520,533` — violates the spec’s own “real symbols” rule.

2. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:176](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:176) — Sprint #1 targets `EmuThreadFunction`, but current branch build logic says that path was reverted because it hits Asyncify `unreachable`; the active injection target is `run_cached_interpreter` — evidence: `build/build.sh:236-240` says retro_run/fiber-swap injection was reverted, and `build/build.sh:491-525` injects `kn_recomp_get_enabled()` / `kn_um_drive_frame_loop()` into `cached_interp.c` — wrong target would reintroduce a known bad design.

3. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:176](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:176) — cited `build/src/.../libretro.c` is an ignored local build checkout, not tracked on `feat/smash64r-wasm` — `.gitignore:8-9` ignores `build/src/`, and `git show feat/smash64r-wasm:build/src/mupen64plus-libretro-nx/libretro/libretro.c` fails — clean dispatches will not have this path unless the build checkout is prepared first.

4. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:177](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:177) — Sprint #2 describes direct `osRecvMesg(BLOCK)` park / `osSendMesg` wake wiring, but in current branch those direct sites are dead code after unconditional returns — `build/kn_recomp/kn_recomp_os.c:1219-1222` returns after vendored `osSendMesg`, `build/kn_recomp/kn_recomp_os.c:1266-1269` returns after vendored `osRecvMesg`; the cited `um_queue_wake_one` / `um_thread_park_on` direct sites are later at `build/kn_recomp/kn_recomp_os.c:1240,1301` — task is stale/misleading.

5. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:179](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:179) and [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:181](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:181) — Sprint #4/#6 assume a remaining depth guard, but current branch says it is already removed — `build/kn_recomp/kn_recomp_shim.c:741-745` documents “Wave 5: depth-guard removed” — dependencies #4-#6 are stale.

6. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:108](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:108) vs [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:116](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:116) — spec says a dispatch helper inlines file ranges, but Codex dispatch pipes the compact brief directly with no helper — Codex would not receive verbatim source despite briefs intentionally omitting file contents.

7. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:46](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:46) — DeepSeek aliases are described as stable/latest-tracking, but current official docs say `deepseek-chat` and `deepseek-reasoner` are deprecated on 2026-07-24 and map to `deepseek-v4-flash` modes — evidence: DeepSeek docs lines 48-53 and API reference lines 147-150 — model naming policy is not durable as written.

8. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:191](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:191) — failure modes omit non-rate-limit API/model failures and incomplete model responses — DeepSeek documents `length`, `content_filter`, and `insufficient_system_resource` finish reasons; spec only covers rate-limit/401 at line 200 — a bad/incomplete response could be captured as if it were valid output.

9. [docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:116](/Users/kazon/kaillera-next/docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md:116) — Codex dispatch does not pin sandbox/output behavior — `codex exec --help` shows `--sandbox` and `--output-last-message`; without them, defaults can allow workspace writes or capture wrapper noise instead of final model text — this bypasses the “Claude validates then applies” flow.

## Verifications
- `EmuThreadFunction` exists in local `build/src/mupen64plus-libretro-nx/libretro/libretro.c:523,525`; `CoreDoCommand(M64CMD_EXECUTE...)` is at `:562`.
- `kn_recomp_get_enabled` exists/exported at `build/kn_recomp/kn_recomp_shim.c:265`.
- `kn_um_drive_frame` exists at `build/kn_recomp/kn_recomp_os.c:728`.
- `osSendMesg` / `osRecvMesg` externs exist at `build/kn_recomp/kn_recomp_os.c:1207-1208`; recomp wrappers exist at `:1210` and `:1260`.
- `um_thread_park_on` is declared/defined at `build/kn_recomp/ultramodern.h:101` and `build/kn_recomp/ultramodern.c:186`.
- `um_queue_wake_one` is declared/defined at `build/kn_recomp/ultramodern.h:106` and `build/kn_recomp/ultramodern.c:202`.
- `kn_get_retro_run_entries` is `EMSCRIPTEN_KEEPALIVE` at `build/kn_recomp/kn_recomp_shim.c:356`.
- `Module._kn_get_retro_run_entries` matches Emscripten’s underscore export convention; generated glue uses `Module["_"+ident]` lookup in `web/smash64r-test/Smash64r.js:9`.
- `cat <brief> | codex exec -` is valid: `codex exec --help` says `-` reads instructions from stdin.
- `Team-Task:` footer should not affect auto-versioning: `scripts/bump-version.sh:103` and `:156` use `git log --format=%s`, i.e. subjects only; workflow gating also checks message prefix at `.github/workflows/version-bump.yml:10-14`.
- `KN_FAST=1` is a real build mode: `build/build.sh:74-85`.
- DeepSeek endpoint not flagged as wrong: official docs show base URL `https://api.deepseek.com` and path `/chat/completions`; I found no proof `/v1/chat/completions` is invalid.

## Suggestions (advisory)
- Rewrite sprint #1/#2/#4/#6 against the current `feat/smash64r-wasm` state before planning; the branch appears past “Phase 2f Wave 1 dormant infrastructure.”
- Make dispatch commands use the eventual inlining helper for both Codex and DeepSeek.
- Add explicit failure handling for nonzero `codex exec`, non-2xx `curl`, empty output, invalid JSON, `finish_reason != stop`, and stale line ranges.
- Mention that `build/src` must be populated/patched before dispatching tasks that cite ignored build sources.