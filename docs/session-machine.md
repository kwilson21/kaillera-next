# Page lifecycle machine

Generated from `web/src/session.ts` by `node scripts/session-diagram.mjs`. Do not edit by hand;
`npm run check` fails when it is out of date.

```mermaid
flowchart LR
  start(( )) --> lobby
  lobby -->|"join mid-game: player<br/>join mid-game: player, streamed<br/>join mid-game: spectator, streamed"| lateJoinStarting
  lobby -->|"join mid-game: spectator<br/>gameStarted"| running
  lateJoinStarting -->|"lateJoinRomNeeded"| lateJoinAwaitingRom
  lateJoinStarting -->|"engineStarted: needs state"| lateJoinSyncing
  lateJoinStarting -->|"engineStarted: no state needed<br/>lateJoinSynced"| running
  lateJoinAwaitingRom -->|"lateJoinRomReady"| lateJoinStarting
  lateJoinSyncing -->|"lateJoinSynced<br/>admittedToStart"| running
```

Not drawn, because every state goes to `lobby` on them: `gameEnded`, `roomClosed`, `rejoinRefused`, `rejoined: game ended while away`, `rejoined: match replaced while away`.
Events that leave a state unchanged are not drawn either.

What `play.js` reads from each state (`sessionFlag`):

| State | A game is on | Waiting for a ROM | Next engine start is the late join |
|---|---|---|---|
| `lobby` | no | no | no |
| `lateJoinStarting` | yes | no | yes |
| `running` | yes | no | no |
| `lateJoinAwaitingRom` | yes | yes | yes |
| `lateJoinSyncing` | yes | no | no |

The Quint model of the same states, with the server beside them, is `specs/room_lifecycle.qnt`.

# Rejoin machine

Generated from `web/src/rejoin-machine.ts` by the same script. `rejoining` invokes the rejoin
program (`web/src/rejoin-attempt.ts`); leaving the state interrupts it.

```mermaid
flowchart LR
  rejoinStart(( )) --> idle
  idle -->|"socketUp, a game is on"| rejoining
  rejoining -->|"socketUp, a game is on (asks again on the new connection)"| rejoining
  rejoining -->|"socketUp, in the lobby<br/>socketDown<br/>gameOver<br/>the rejoin program ends (its outcome is delivered)"| idle
```
