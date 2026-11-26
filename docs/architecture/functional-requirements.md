# Functional requirements

Provide a browser-playable shared retro game. Preserve the identity of the match, agree on the inputs and frame history that determine play, and make failures observable. The leaf IDs below are the rows of the [design matrix](design-matrix.json).

## Establish and sustain a match

| FR | Requirement and acceptance boundary |
| --- | --- |
| `FR-room` | Admit room members, start one authorized match, and end or resume it under the current host lease. A stale host must be unable to advance a replaced match. |
| `FR-roster` | Keep player identities, seats, and controller permissions consistent. A frame consumes the controller mask and input owners in force at that frame's input tag. |
| `FR-session` | Keep each page in the room and match it actually joined. Route start, reconnect, match end, and replacement to the current page lifecycle. |
| `FR-peers` | Connect the intended identities with current connection attempts and recover lost primary connections. Reject stale offers, answers, and old channels. |
| `FR-delivery` | Deliver player input below the simulation boundary. Accept identical copies idempotently and continue reliable delivery if the optional channel closes. |

## Execute and reconcile the simulation

| FR | Requirement and acceptance boundary |
| --- | --- |
| `FR-boot` | Load the selected compatible emulator once per current boot attempt. Cancel obsolete work and surface bounded failure. |
| `FR-execution` | Advance the emulator using the authorized inputs and one frame authority. Native rollback and lockstep simulate on each player page. Streaming simulates only on the host. |
| `FR-replay` | In rollback mode, record predictions and replay exactly when actual input differs within the retained window. Preserve the same owner's predictions across a safe reconnect. |
| `FR-pacing` | Advance live frames at the agreed input horizon. Bound waits and give a blocked frame a defined action without charging a local page freeze to its peers. |
| `FR-recovery` | Detect divergent or irrecoverable history, install the current host's state at a safe boundary, and settle or fail each recovery within its deadline under continued scheduling. |
| `FR-admission` | Attach a late joiner to the current state, input history, and roster, then release waiting pages on completion or timeout. A page reconnecting to the same match retains its identity, but a new joiner needs admission to the simulation. |

## Present and operate the match

| FR | Requirement and acceptance boundary |
| --- | --- |
| `FR-spectators` | Let a watcher receive the current host's media and leave it when the match ends. Watching alone grants no simulation slot or player authority. |
| `FR-presentation` | Present live video and audio in the selected mode. Suppress replay-only output side effects and keep committed output available during normal play. |
| `FR-diagnostics` | Record and retrieve scoped events, logs, and recovery evidence while respecting capture consent and bounded collection. |

The frame-level FRs apply where the mode replicates the simulation. Streaming still exercises room, session, browser connection, host execution, input, media, and diagnostics paths. Transport delivery and late admission are separate because a functioning link does not establish controller ownership or a valid simulation history.
