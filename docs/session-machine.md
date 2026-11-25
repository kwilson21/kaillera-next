# Page lifecycle machine

Generated from `web/src/session.ts` by `node scripts/session-diagram.mjs`. Do not edit by hand;
`npm run check` fails when it is out of date.

```mermaid
flowchart LR
  start(( )) --> lobby
  lobby -->|"wait for host"| waitingForHost
  lobby -->|"join mid-game: player<br/>join mid-game: player, streamed<br/>join mid-game: spectator, streamed"| lateJoinStarting
  lobby -->|"join mid-game: spectator<br/>gameStarted<br/>gameStarted: next match"| running
  waitingForHost -->|"host returned"| lobby
  waitingForHost -->|"gameStarted<br/>gameStarted: next match"| running
  lateJoinStarting -->|"host peer lost during hold"| lateJoinWaitingForHost
  lateJoinStarting -->|"rejoined: game ended while away<br/>rejoined: match replaced while away"| lobby
  lateJoinStarting -->|"lateJoinRomNeeded"| lateJoinAwaitingRom
  lateJoinStarting -->|"engineStarted: needs state"| lateJoinSyncing
  lateJoinStarting -->|"engineStarted: no state needed<br/>lateJoinSynced"| running
  running -->|"host peer lost during hold"| lateJoinWaitingForHost
  running -->|"rejoined: game ended while away<br/>rejoined: match replaced while away"| lobby
  running -->|"lateJoinRomNeeded"| lateJoinAwaitingRom
  running -->|"leftOutOfStart"| lateJoinStarting
  lateJoinWaitingForHost -->|"host can serve this match"| lateJoinStarting
  lateJoinWaitingForHost -->|"gameStarted: next match"| running
  lateJoinWaitingForHost -->|"rejoined: game ended while away<br/>rejoined: match replaced while away"| lobby
  lateJoinAwaitingRom -->|"host peer lost during hold"| lateJoinWaitingForHost
  lateJoinAwaitingRom -->|"rejoined: game ended while away<br/>rejoined: match replaced while away"| lobby
  lateJoinAwaitingRom -->|"lateJoinRomReady"| lateJoinStarting
  lateJoinSyncing -->|"host peer lost during hold"| lateJoinWaitingForHost
  lateJoinSyncing -->|"rejoined: game ended while away<br/>rejoined: match replaced while away"| lobby
  lateJoinSyncing -->|"leftOutOfStart"| lateJoinStarting
  lateJoinSyncing -->|"lateJoinSynced<br/>admittedToStart"| running
```

Not drawn, because every state goes to `lobby` on them: `gameEnded`, `roomClosed`, `rejoinRefused`.
Events that leave a state unchanged are not drawn either.

What `play.js` reads from each state (`sessionFlag`):

| State | A game is on | Waiting for a ROM | Next engine start is the late join |
|---|---|---|---|
| `lobby` | no | no | no |
| `waitingForHost` | no | no | no |
| `lateJoinStarting` | yes | no | yes |
| `running` | yes | no | no |
| `lateJoinWaitingForHost` | yes | no | no |
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

# Saved fight return

Each original seat waits for its local engine and the room grant for the same match.
Generated from `web/src/play/match-return.ts`. The Quint model is `room_saved_seat_fixed` in `specs/room_member_return.qnt`.

```mermaid
flowchart LR
  returnStart(( )) --> installing
  installing -->|"install"| waitingForPlayers
  installing -->|"grant"| grantedBeforeInstall
  installing -->|"cancel"| cancelled
  waitingForPlayers -->|"grant"| playing
  waitingForPlayers -->|"restart"| installing
  waitingForPlayers -->|"cancel"| cancelled
  grantedBeforeInstall -->|"install"| playing
  grantedBeforeInstall -->|"cancel"| cancelled
```

# Emulator boot

One request owns core preparation and loader construction until completion, timeout or teardown.
Generated from `web/src/play/emulator-boot.ts`. The Quint model is `emulator_boot_fixed` in `specs/emulator_boot.qnt`.

```mermaid
flowchart LR
  bootStart(( )) --> idle
  idle -->|"request"| preparing
  preparing -->|"prepared"| loading
  preparing -->|"complete or cancel"| idle
  loading -->|"complete or cancel"| idle
```
