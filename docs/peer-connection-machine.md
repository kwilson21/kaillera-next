# Peer connection machine

Generated from `web/src/peer-connection.ts` by `node scripts/peer-connection-diagram.mjs`. Do not edit
by hand; `npm run check` fails when it is out of date.

One machine per other player, as one page sees the WebRTC connection to them. It is one side of
`specs/peer_connection.qnt`, built to the variant `peer_connection_fixed`. Nothing uses it yet: the
engine keeps its own flags and timers.

```mermaid
flowchart LR
  start(( )) --> absent
  subgraph reconnecting
    reconnecting_awaitingOffer["awaitingOffer"]
    reconnecting_offering["offering"]
    reconnecting_answering["answering"]
  end
  absent -->|"roster (lower slot, before the match) / offer"| offering
  absent -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect (before the match) / answer"| answering
  offering -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect (before the match) / answer"| answering
  offering -->|"lost (before the match) / offer<br/>startupAfter (before the match) / offer"| offering
  absent -->|"offer: reconnect (in a match) / answer"| reconnecting_answering
  answering -->|"opened"| open
  answering -->|"lost (before the match) / drop"| absent
  offering -->|"offer: reconnect (in a match) / answer"| reconnecting_answering
  offering -->|"healAfter (in a match) / reset, offer"| healing
  offering -->|"opened"| open
  absent -->|"healAfter (lower slot, in a match) / offer"| healing
  answering -->|"offer: reconnect (in a match) / answer<br/>healAfter (higher slot, in a match)"| reconnecting_answering
  answering -->|"healAfter (lower slot, in a match) / reset, offer"| healing
  answering -->|"answerAfter (in a match) / close"| awaitingOffer
  reconnecting_answering -->|"opened (lower slot)<br/>opened (higher slot) / reset"| open
  reconnecting -->|"giveUpAfter / drop"| absent
  reconnecting_answering -->|"answerAfter / close"| reconnecting_awaitingOffer
  open -->|"offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect (before the match) / answer"| answering
  open -->|"lost (before the match) / drop"| absent
  healing -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer"| answering
  healing -->|"offer: reconnect / answer"| reconnecting_answering
  healing -->|"healAfter / reset, offer"| healing
  open -->|"lost (lower slot, before the match) / offer"| offering
  offering -->|"lost (before the match) / stalled<br/>startupAfter (before the match) / stalled"| stalled
  open -->|"offer: reconnect (in a match) / answer"| reconnecting_answering
  open -->|"lost (lower slot, in a match) / offer"| reconnecting_offering
  awaitingOffer -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect (higher slot, before the match) / answer"| answering
  awaitingOffer -->|"offer: reconnect (in a match) / answer"| reconnecting_answering
  awaitingOffer -->|"healAfter (lower slot, in a match) / reset, offer"| healing
  reconnecting_awaitingOffer -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect / answer"| reconnecting_answering
  healing -->|"opened"| open
  stalled -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect (before the match) / answer"| answering
  reconnecting_offering -->|"offer: first / answer<br/>offer: first, from a new page / drop, answer<br/>offer: startup / answer<br/>offer: reconnect / answer"| reconnecting_answering
  reconnecting_offering -->|"attemptAfter / offer"| reconnecting_offering
  stalled -->|"opened"| open
  stalled -->|"offer: reconnect (in a match) / answer"| reconnecting_answering
  stalled -->|"healAfter (in a match) / reset, offer"| healing
  reconnecting_offering -->|"opened"| open
  reconnecting_offering -->|"attemptAfter / drop"| absent
  absent -->|"roster (higher slot, before the match)"| awaitingOffer
  awaitingOffer -->|"healAfter (higher slot, in a match)"| reconnecting_awaitingOffer
  open -->|"lost (higher slot, in a match)"| reconnecting_awaitingOffer
```

An arrow reads `event (who, when) / commands`: the event or deadline, the page and phase it is taken
in when the state can be met in more than one, and what the machine wants done (it does none of it
itself). The walk is made as the lower slot and as the higher slot of a pair, before and in a match.
The pair walked is the host (slot 0, the lower slot) and one guest. The `reset` on a reconnect goes by
the page, not the pair: every page but the host issues it, so between two guests the lower slot does too.

Not drawn, because every state it moves goes to `absent` on it: `left`.
Not drawn, because every state it moves goes to `absent` on it: `matchEnded`.
Events that leave a state unchanged are not drawn either, unless they make a new offer. Among them:
an answer, a candidate or a channel event for an attempt other than the entry’s, which is ignored
everywhere, and a roster update while the channel is open.

Each state, what it is in the model, and what the engine keeps as flags for it (`peerFacts`):

| State | In the model (`Side`) | Entry | Channel open | Reconnecting |
|---|---|---|---|---|
| `absent` | `has` is false | no | no | no |
| `awaitingOffer` | `has`; nothing offered or answered | yes | no | no |
| `offering` | `made` (then `link`) is its own offer, `attempt` >= 1: the roster offer or a startup retry | yes | no | no |
| `stalled` | the same after the last startup retry: `attempt` = 0, `stalled` | yes | no | no |
| `answering` | `link` is their offer, not `open`, not `recon` | yes | no | no |
| `healing` | `made` (then `link`) is the offer the health check made: `attempt` = 0, not `recon` | yes | no | no |
| `open` | `open` | yes | yes | no |
| `reconnecting.awaitingOffer` | `recon` and `giveUp`; no connection | yes | no | yes |
| `reconnecting.offering` | `recon` and `giveUp`; `made` (then `link`) is its own offer, `attempt` >= 1 | yes | no | yes |
| `reconnecting.answering` | `recon` and `giveUp`; `link` is their offer, `ansTimer` | yes | no | yes |

The deadlines (`PEER_TIMING`, the engine’s numbers today):

| Deadline | In the model | After | Armed in |
|---|---|---|---|
| `startupAfter` | `startupTimeout` | 8 s | `offering` |
| `attemptAfter` | `attemptTimeout` | 10 s | `reconnecting.offering` |
| `giveUpAfter` | `giveUpTimeout` | 45 s | `reconnecting` |
| `answerAfter` | `answerTimeout` | 10 s | `answering`, `reconnecting.answering` |
| `healAfter` | `heal` | 5 s | `absent`, `awaitingOffer`, `offering`, `stalled`, `answering`, `healing` |

`startupAfter` acts only before the match, `healAfter` only in one; `giveUpAfter` runs across the
states of `reconnecting`.
