# Protected reconnect proof

Current capable peers negotiate via the ready handshake. The dedicated
request is intentionally not a legacy resync: an older receiver ignores it.
At capture, the host checks the returning player’s native receipts and
that every active player’s consumed inputs are confirmed.
The full state carries the exact proof atomically in its DC header or in the
match-scoped socket state message. Opaque or stale state cannot complete
the protected request; bounded retries keep the same protocol.

Only a current authored input packet drained by native rollback can enter
the receipt ledger. Successful handoff retains bounded permission for an
explicit retry; it is not confirmation that the guest applied the state. Sealed
and late-join snapshots respect the capture fence. Phantom work postponed
by the fence is retained for a current generation.

Three or four original native players can also negotiate `checkpointRecoveryV1`.
Every 128 frames each peer may seal a full local checkpoint against its last
agreed state and the inputs the cores consumed. Each owner verifies its own
column. The journal retains 2,048 tags per slot, including neutral inputs.

After an unsafe channel replacement, the host binds the numbered request to
the original match, socket roster, epoch, checkpoint and common stop frame.
Each peer restores its own agreed bytes and replays the authenticated owner
journals. Every installed core must agree on the full state and replay history.
The host then releases the new epoch. Peers wait for every first input before
resuming. An incomplete install stays paused. A peer missing the decision
asks again. A terminal room integrity report still prevents recovery. An ordinary
state load ends checkpoint rotation for that epoch. See the [coordinator](../web/src/checkpoint-recovery.ts) and
[barrier model](../specs/checkpoint_recovery.qnt).
