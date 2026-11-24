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

A match whose safe input history is exhausted may remain unresolved; this
does not coordinate an all-peer snapshot install or end a match. Unresolved
host debt can still prevent separate snapshots while its slot is rostered;
an unresolved guest does not take an ordinary snapshot as verified recovery.
The wire rules model does not prove room-wide progress or atomic settlement.
