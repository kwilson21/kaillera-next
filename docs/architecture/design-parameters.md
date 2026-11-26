# Design parameters

The leaf IDs below are the columns of the [design matrix](design-matrix.json). The implementation sources and existing verification for their effects are recorded per entry.

## Room and connection authority

| DP | Current implementation and ownership |
| --- | --- |
| `DP-room` | FastAPI/Socket.IO room mutations and match epochs in `server/src/api/signaling.py`, with optional Redis room persistence. Server owns admission, match start/end, and the reservation lease. |
| `DP-roster` | Server seats and roles, host frame-tagged controller masks and cuts, and local controller input from `web/src/page`. Server seats grant eligibility. The in-match host mask determines when it takes effect in simulation. |
| `DP-session` | `web/src/session.ts` and the page's reconnect reconciliation in `web/static/play.js`. The page machine owns lifecycle routing for the accepted match. |
| `DP-peers` | Signaling relay and attempt identities, per-peer XState logic in `web/src/peer-connection.ts`, and the engine's WebRTC driver and channel ownership checks. Streaming uses a host-owned link and media negotiation. |
| `DP-delivery` | Native engine send/receive, input redundancy, and channel fallback. This owns transport availability, retries, and duplicate admission. Simulation consumes the decoded, frame-tagged input. |

## Simulation authority

| DP | Current implementation and ownership |
| --- | --- |
| `DP-boot` | XState and Effect in `web/src/play/emulator-boot.ts`, driven by the page with cancellation passed to the loader. The current loader owns the current emulator instance. |
| `DP-execution` | The patched WASM core's pre/step/post calls, the engine's main-loop adapter, and the streaming host's emulator loop. Native C owns the running frame. JavaScript publishes and uses a mirror at frame boundaries. |
| `DP-replay` | Input and prediction tables, state ring, and pending replay in `build/kn_rollback/kn_rollback.c`. The JavaScript runner and optional replay worker execute or commit work against the current timeline. |
| `DP-pacing` | Native engine tick gates, input wait identity, freeze credit, and paced dispatch, plus typed start and lockstep rules. It owns when an otherwise valid step may run. |
| `DP-recovery` | Digests, numbered requests, per-recipient delivery actors, and snapshot apply and input settlement in the native engine. Host is the corrective source. The recipient validates attempt, request, match, and frame before acknowledging. |
| `DP-admission` | Host serve ID and pause per joiner, Effect-based waiting in `web/src/late-join-wait.ts`, and the typed late-join input bridge. The host publishes admission after readiness. |

## Presentation and evidence

| DP | Current implementation and ownership |
| --- | --- |
| `DP-spectators` | Host stream capture and per-spectator sender attachment, plus watcher playback and teardown. |
| `DP-presentation` | Committed canvas/PCM output, `web/src/page/audio.ts`, the AudioWorklet, and video playback. Replay output gates keep historical audiovisual work from entering the live output pipeline. |
| `DP-diagnostics` | Browser telemetry, C log drain, and capture policy. Server ingests authorized match/epoch/sequence records and exposes stored evidence to administrators. Digest comparison that can trigger correction belongs to recovery. |
