# Page lifecycle machine

Generated from `web/src/session.ts` by `node scripts/session-diagram.mjs`. Do not edit by hand;
`npm run check` fails when it is out of date.

Events that leave the state unchanged are not drawn. `gameEnded` and `roomClosed` return every
state to the lobby.

```mermaid
stateDiagram-v2
  [*] --> lobby
  lobby --> lateJoinStarting: joined mid-game / joined mid-game (streamed) / joined mid-game as spectator (streamed)
  lobby --> running: joined mid-game as spectator / gameStarted
  lateJoinStarting --> lobby: gameEnded / roomClosed
  lateJoinStarting --> lateJoinAwaitingRom: lateJoinRomNeeded
  lateJoinStarting --> lateJoinSyncing: engineStarted (needs state)
  lateJoinStarting --> running: engineStarted (no state needed) / lateJoinSynced
  running --> lobby: gameEnded / roomClosed
  lateJoinAwaitingRom --> lobby: gameEnded / roomClosed
  lateJoinAwaitingRom --> lateJoinStarting: lateJoinRomReady
  lateJoinSyncing --> lobby: gameEnded / roomClosed
  lateJoinSyncing --> running: lateJoinSynced
```

What `play.js` reads from each state (`sessionFlag`):

| State | A game is on | Waiting for a ROM | Next engine start is the late join |
|---|---|---|---|
| `lobby` | no | no | no |
| `lateJoinStarting` | yes | no | yes |
| `running` | yes | no | no |
| `lateJoinAwaitingRom` | yes | yes | yes |
| `lateJoinSyncing` | yes | no | no |

The Quint model of the same states, with the server beside them, is `specs/room_lifecycle.qnt`.
