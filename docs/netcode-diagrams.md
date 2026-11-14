# Netcode diagrams

Every diagram here is generated from the code or the model it describes and checked by
`npm run check`, so none can drift from its source. To change one, change the source and
run the generator named beside it.

## State machines

| Diagram | What it covers | Source | Generator |
|---|---|---|---|
| [Page lifecycle](session-machine.md) | What one page is doing: in the lobby, joining a match in play, or running one | `web/src/session.ts` | `npm run diagram` |
| [Peer connection](peer-connection-machine.md) | The WebRTC connection to one other player as one page sees it: offering, answering, open, reconnecting, and the deadline on each wait. Built to the model's `fixed` variant; not yet run beside the engine | `web/src/peer-connection.ts` | `npm run diagram` |

## Orderings from the Quint models

| Diagram | What it covers | Source | Generator |
|---|---|---|---|
| [Spec scenarios](spec-traces.md) | The `run` scenarios of the room lifecycle model as sequence diagrams: host reload, socket drop, late join with and without a ROM, joining while others load | `specs/room_lifecycle.qnt` | `npm run traces` |

A counterexample the model checker finds can be drawn the same way; the commands are at
the top of `scripts/trace-diagram.mjs`.
