// -*- mode: Bluespec; -*-
//
// Peer identity: which WebRTC connection the host keeps for a player whose
// Socket.IO id changes (web/src/peer-identity.ts, called from onUsersUpdated
// in web/static/netplay-rollback.js).
//
// The match runs over WebRTC connections that outlive the signaling socket.
// Each time a player's socket reconnects the server gives them a new id, and
// the roster the host receives lists them under it. The host must work out
// that the connection it already has is theirs. If it cannot, it treats that
// connection as stale, closes it and waits for a new one: the match freezes.
//
// What is modelled, from the host's side, for two guests in fixed slots:
//   dropSignaling    a guest's socket drops; the server's roster omits them
//   dropHost         the host's own socket drops; it hears no roster updates
//   hostRejoin       the host's socket returns; it is sent the current roster
//   rejoin           a guest's socket returns under a new id
//   p2pDrop          a WebRTC connection dies
//   recreate         mesh heal / late-join reconnect makes a new connection
//                    under the key the host already uses for that player
//   connect          a new connection comes up
//
// Not modelled: more than one connection per slot at a time, spectators,
// slot changes, the guests' own view of the host.
//
// KEEP_BY_IDENTITY: the connection records which player it belongs to and a
//   roster entry with no history is matched on that (#119). false = before.
// TAG_ON_CREATE: a recreated connection records its player at once (#119
//   review fix). false = only when the next roster update arrives.
module peer_identity {
  const KEEP_BY_IDENTITY: bool
  const TAG_ON_CREATE: bool

  pure val GUESTS = Set("g1", "g2")
  pure def slotOf(p: str): int = if (p == "g1") 1 else 2

  type Conn = { key: int, pid: str, tagged: bool, live: bool }
  type Known = { key: int, pid: str, sid: int }

  var sid: str -> int          // each guest's current socket id, 0 = signaling down
  var nextSid: int
  var hostUp: bool
  var conns: Set[Conn]         // the host's connection table; pid is whose it really is
  var known: Set[Known]        // the host's map from connection key to roster player
  var evictedLive: bool        // history: the host closed a connection that was live

  // ── the decision (rosterKey in web/src/peer-identity.ts) ───────────────

  pure def rosterKey(p: str, s: int, cs: Set[Conn], prev: Set[Known], byIdentity: bool): int =
    if (cs.exists(c => c.key == s)) s
    else {
      // The previous roster already mapped this player: keep that mapping
      // if it names this id, or the connection is live.
      val fromHistory = prev.filter(k => and {
        k.pid == p, k.key != s,
        cs.exists(c => c.key == k.key and (k.sid == s or c.live)),
      })
      // Otherwise a live connection that says it is this player's.
      val fromIdentity = cs.filter(c => byIdentity and c.tagged and c.pid == p and c.live and c.key != s)
      if (fromHistory != Set()) fromHistory.fold(0, (acc, k) => k.key)
      else if (fromIdentity != Set()) fromIdentity.fold(0, (acc, c) => c.key)
      else s
    }

  // ── the host processing a roster (onUsersUpdated) ──────────────────────

  def roster: Set[str] = GUESTS.filter(p => sid.get(p) != 0)

  // The key each listed guest gets, given the table and the previous map.
  def keysFor(listed: Set[str], sids: str -> int): str -> int =
    listed.mapBy(p => rosterKey(p, sids.get(p), conns, known, KEEP_BY_IDENTITY))

  action processRoster(sids: str -> int): bool = {
    val listed = GUESTS.filter(p => sids.get(p) != 0)
    val keyOf = keysFor(listed, sids)
    // A listed guest whose key names no connection gets a new one; whatever
    // else the host holds for that player's slot is evicted.
    val needNew = listed.filter(p => not(conns.exists(c => c.key == keyOf.get(p))))
    val evicted = conns.filter(c => needNew.contains(c.pid))
    val kept = conns.exclude(evicted)
    all {
      known' = listed.map(p => { key: keyOf.get(p), pid: p, sid: sids.get(p) }),
      conns' = kept
        .map(c => if (listed.contains(c.pid) and keyOf.get(c.pid) == c.key) c.with("tagged", true) else c)
        .union(needNew.map(p => { key: sids.get(p), pid: p, tagged: true, live: false })),
      evictedLive' = (evictedLive or evicted.exists(c => c.live)),
    }
  }

  action unchangedTable = all { conns' = conns, known' = known, evictedLive' = evictedLive }

  // ── actions ────────────────────────────────────────────────────────────

  // The match is under way: both guests connected, known and tagged.
  action init = all {
    sid' = Map("g1" -> 1, "g2" -> 2),
    nextSid' = 3,
    hostUp' = true,
    conns' = Set(
      { key: 1, pid: "g1", tagged: true, live: true },
      { key: 2, pid: "g2", tagged: true, live: true },
    ),
    known' = Set({ key: 1, pid: "g1", sid: 1 }, { key: 2, pid: "g2", sid: 2 }),
    evictedLive' = false,
  }

  action dropSignaling(p: str): bool = all {
    sid.get(p) != 0,
    sid' = sid.set(p, 0), nextSid' = nextSid, hostUp' = hostUp,
    if (hostUp) processRoster(sid.set(p, 0)) else unchangedTable,
  }

  action rejoin(p: str): bool = all {
    sid.get(p) == 0,
    sid' = sid.set(p, nextSid), nextSid' = nextSid + 1, hostUp' = hostUp,
    if (hostUp) processRoster(sid.set(p, nextSid)) else unchangedTable,
  }

  action dropHost = all {
    hostUp, hostUp' = false, sid' = sid, nextSid' = nextSid, unchangedTable,
  }

  action hostRejoin = all {
    not(hostUp), hostUp' = true, sid' = sid, nextSid' = nextSid, processRoster(sid),
  }

  action p2pDrop(p: str): bool = all {
    conns.exists(c => c.pid == p and c.live),
    conns' = conns.map(c => if (c.pid == p) c.with("live", false) else c),
    known' = known, evictedLive' = evictedLive,
    sid' = sid, nextSid' = nextSid, hostUp' = hostUp,
  }

  // Mesh heal or a late-join reconnect: a dead connection is replaced by a
  // new one under the same key, with no roster update to say whose it is.
  action recreate(p: str): bool = all {
    conns.exists(c => c.pid == p and not(c.live)),
    known.exists(k => k.pid == p),
    conns' = conns.map(c => if (c.pid == p) { ...c, tagged: TAG_ON_CREATE, live: true } else c),
    known' = known, evictedLive' = evictedLive,
    sid' = sid, nextSid' = nextSid, hostUp' = hostUp,
  }

  action connect(p: str): bool = all {
    conns.exists(c => c.pid == p and not(c.live)),
    conns' = conns.map(c => if (c.pid == p) c.with("live", true) else c),
    known' = known, evictedLive' = evictedLive,
    sid' = sid, nextSid' = nextSid, hostUp' = hostUp,
  }

  action step = any {
    dropHost,
    hostRejoin,
    nondet p = oneOf(GUESTS)
    any { dropSignaling(p), rejoin(p), p2pDrop(p), recreate(p), connect(p) },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // The host never closes a connection that is up. Signaling coming and
  // going, in any order, must not cost a player their place in the match.
  val neverEvictsLiveConnection = not(evictedLive)

  // At most one connection per guest.
  val oneConnectionPerGuest =
    GUESTS.forall(p => conns.filter(c => c.pid == p).size() <= 1)

  // ── scenarios ──────────────────────────────────────────────────────────

  // #119: both lose signaling, the host's comes back first.
  run hostRejoinsFirstTest =
    init
      .then(dropHost)
      .then(dropSignaling("g1"))
      .then(hostRejoin)
      .then(rejoin("g1"))
      .expect(evictedLive == not(KEEP_BY_IDENTITY))

  // The order that always worked: the guest is back before the host.
  run guestRejoinsFirstTest =
    init
      .then(dropHost)
      .then(dropSignaling("g1"))
      .then(rejoin("g1"))
      .then(hostRejoin)
      .expect(not(evictedLive))

  // The #119 review finding: the connection was recreated by mesh heal, with
  // no roster update since, and then the host-first ordering happens.
  run recreatedThenHostFirstTest =
    init
      .then(p2pDrop("g1"))
      .then(recreate("g1"))
      .then(dropHost)
      .then(dropSignaling("g1"))
      .then(hostRejoin)
      .then(rejoin("g1"))
      .expect(evictedLive == not(KEEP_BY_IDENTITY and TAG_ON_CREATE))
}

// Before #119.
module peer_identity_before {
  import peer_identity(KEEP_BY_IDENTITY = false, TAG_ON_CREATE = false).*
}

// #119 as first written: identity recorded only on roster updates.
module peer_identity_untagged {
  import peer_identity(KEEP_BY_IDENTITY = true, TAG_ON_CREATE = false).*
}

// Today.
module peer_identity_current {
  import peer_identity(KEEP_BY_IDENTITY = true, TAG_ON_CREATE = true).*
}
