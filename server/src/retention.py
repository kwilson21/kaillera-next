"""Retention tiers: which matches are kept until someone resolves them.

A match is flagged when its session logs show a crash, freeze or desync, a
client reports a fatal error, a vision check finds a visual desync, or a
player sends feedback about it (docs/superpowers/specs/
2026-09-25-offbox-log-storage-design.md §2). Flagged matches are kept until
resolved; the rest follow the normal retention window. Flags are stored by
db.flag_match; this module decides what counts as a problem in the logs.
"""

from __future__ import annotations

from collections.abc import Iterable

# First word of a session-log message that flags a match on any occurrence:
# rollback integrity violations, stalls and freezes.
_ANY_TAGS = frozenset(
    {
        "REPLAY-NORUN",
        "RB-INVARIANT-VIOLATION",
        "RB-LIVE-MISMATCH",
        "TICK-STUCK",
        "RB-INPUT-STALL-TIMEOUT",
        "PEER-PHANTOM",
        "LOCAL-FREEZE",
    }
)
# ...and any tag with one of these prefixes: the C engine's FATAL lines
# (FATAL, FATAL-RING-STALE, ...) and rollback-invariant events
# (RB-INVARIANT-FIXUP, RB-INVARIANT-VIOLATION).
_ANY_PREFIXES = ("FATAL", "RB-INVARIANT-")
# Out-of-range inputs from one peer this many times in a match is a storm.
_INPUT_OOR_STORM = 20


def classify_entries(entries: Iterable[dict]) -> list[dict]:
    """Flag reasons found in a match's session-log entries (all slots merged).

    Each reason is {"signal", "count", "slot", "first_f"}: how often the
    signal appeared, the slot it first came from, and its earliest frame.
    Only the message's first word is matched, since the client logs every
    event as `TAG key=value ...`.
    """
    found: dict[str, dict] = {}
    oor: dict[object, list[dict]] = {}
    for entry in entries:
        msg = entry.get("msg")
        if not isinstance(msg, str):
            continue
        # The C engine's own log lines are relayed with a "[C] " prefix.
        tag = msg.removeprefix("[C] ").split(" ", 1)[0].rstrip(":")
        if tag == "INPUT-OOR":
            oor.setdefault(entry.get("slot"), []).append(entry)
            continue
        if tag == "RB-CHECK" and "MISMATCH" in msg:
            signal = "RB-CHECK-MISMATCH"
        elif tag in _ANY_TAGS or tag.startswith(_ANY_PREFIXES):
            signal = tag
        else:
            continue
        _count(found, signal, entry)
    for slot_entries in oor.values():
        if len(slot_entries) >= _INPUT_OOR_STORM:
            for entry in slot_entries:
                _count(found, "INPUT-OOR-STORM", entry)
    return list(found.values())


def _count(found: dict[str, dict], signal: str, entry: dict) -> None:
    frame = entry.get("f")
    reason = found.get(signal)
    if reason is None:
        found[signal] = {"signal": signal, "count": 1, "slot": entry.get("slot"), "first_f": frame}
        return
    reason["count"] += 1
    if isinstance(frame, int | float) and (reason["first_f"] is None or frame < reason["first_f"]):
        reason["first_f"] = frame
