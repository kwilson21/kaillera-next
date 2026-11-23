# Netcode diagrams

Every diagram here is generated from the code or the model it describes and checked by
`npm run check`, so none can drift from its source. To change one, change the source and
run the generator named beside it.

## State machines

| Diagram | What it covers | Source | Generator |
|---|---|---|---|
| [Page lifecycle](session-machine.md) | What one page is doing: in the lobby, joining a match in play, or running one | `web/src/session.ts` | `npm run diagram` |
| [Peer connection](peer-connection-machine.md) | The WebRTC connection to one other player as one page sees it: offering, answering, open, reconnecting, and the deadline on each wait. Built to the model's `fixed` variant; driven by the rollback engine, deciding the mesh health check (`heal`) | `web/src/peer-connection.ts` | `npm run diagram` |
| [Demo run state](demo-run-machine.md) | What the demo page is doing: engine, emulator loader, match, the Pause button, auto-compare, mode, and whether the player has touched the controls. `demo.js` reads its state from it and does what it issues | `web/src/demo/run-state.ts` | `npm run diagram` |

## Orderings from the Quint models

| Diagram | What it covers | Source | Generator |
|---|---|---|---|
| [Spec scenarios](spec-traces.md) | The `run` scenarios of the room lifecycle model as sequence diagrams: host reload, socket drop, late join with and without a ROM, joining while others load. From the game-end model, a lost end event, an unanswered host request, and an old retry after a rematch. From the streaming connection model, a dropped connection: never offered again before the host's deadline, and offered again today. From the ROM identity model, a guest's ROM judged while a drop is being hashed: the host's ROM refused by the previous ROM's hash before, and kept today; and the host changing its ROM: the guest's ROM refused against the host's previous one, and counted ready on it, before, and judged only once the host's new hash is the room's today | `specs/room_lifecycle.qnt`, `specs/game_end.qnt`, `specs/streaming_connection.qnt`, `specs/rom_identity.qnt` | `npm run traces` |

A counterexample the model checker finds can be drawn the same way; the commands are at
the top of `scripts/trace-diagram.mjs`.
