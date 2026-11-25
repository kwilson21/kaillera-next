// Room ownership may transfer mid-match. Controller numbers stay put until
// the lobby, where the successor match's native host must be its room owner.
module room_owner_seat {
  const NORMALIZE_LOBBY_SEATS: bool
  const END_ON_NATIVE_LEAVE: bool
  pure val slots = Set(0, 1, 2)
  var members: Set[str]
  var owner: str
  var seats: int -> str
  var playing: bool
  var authorityLeft: bool

  // A player already in P1 goes to the owner's previous seat.
  pure def seatOwner(table: int -> str, successor: str): int -> str =
    slots.mapBy(i =>
      if (i == 0) successor
      else if (table.get(i) != successor) table.get(i)
      else if (NORMALIZE_LOBBY_SEATS) table.get(0) else "")

  action init = all {
    members' = Set("A", "B", "C"), owner' = "A",
    seats' = Map(0 -> "A", 1 -> "B", 2 -> "C"), playing' = true, authorityLeft' = false,
  }
  action leaveOwner(successor: str, deliberateNativeLeave: bool): bool = {
    val ends = deliberateNativeLeave and playing and seats.get(0) == owner and END_ON_NATIVE_LEAVE
    all {
      members.contains(successor), successor != owner,
      members' = members.exclude(Set(owner)), owner' = successor,
      playing' = (playing and not(ends)),
      authorityLeft' = (authorityLeft or (deliberateNativeLeave and playing and seats.get(0) == owner)),
      val remaining = slots.mapBy(i => if (seats.get(i) == owner) "" else seats.get(i))
      seats' = if (playing and not(ends)) remaining else seatOwner(remaining, successor),
    }
  }
  action join = all {
    not(members.contains("D")), members.size() < 3,
    val free = if (seats.get(0) == "") 0 else if (seats.get(1) == "") 1 else 2
    seats' = seats.set(free, "D"), members' = members.union(Set("D")), owner' = owner, playing' = playing, authorityLeft' = authorityLeft,
  }
  action endMatch = all {
    playing, playing' = false, owner' = owner, members' = members, authorityLeft' = authorityLeft,
    seats' = if (NORMALIZE_LOBBY_SEATS) seatOwner(seats, owner) else seats,
  }
  action step = any {
    nondet successor = oneOf(members)
    nondet deliberate = oneOf(Set(true, false))
    leaveOwner(successor, deliberate), endMatch, join,
    all {members' = members, owner' = owner, seats' = seats, playing' = playing, authorityLeft' = authorityLeft},
  }

  val lobbyOwnerIsP1 = playing or seats.get(0) == owner
  val everyPlayerHasASeat = members.forall(p => slots.filter(i => seats.get(i) == p).size() == 1)
  val authorityLeaveEndsMatch = not(authorityLeft and playing)
  val allHold = lobbyOwnerIsP1 and everyPlayerHasASeat and authorityLeaveEndsMatch

  run nativeAuthorityLeavesTest = init.then(leaveOwner("B", true)).then(join)
    .expect((not(playing) and seats.get(0) == owner and seats.get(1) == "D") == END_ON_NATIVE_LEAVE)
  run ownerWaitsUntilEndTest = init.then(leaveOwner("B", false)).expect(seats.get(1) == "B" and seats.get(0) == "")
    .then(endMatch).expect(lobbyOwnerIsP1 == NORMALIZE_LOBBY_SEATS)
  run occupiedP1AtEndTest = init.then(leaveOwner("B", false)).then(join).expect(seats.get(0) == "D")
    .then(endMatch).expect((seats.get(0) == "B" and seats.get(1) == "D") == NORMALIZE_LOBBY_SEATS)
  run secondHandoffTest = init.then(leaveOwner("B", false)).then(endMatch).then(join).then(leaveOwner("C", false))
    .expect(seats.get(0) == "C").expect(everyPlayerHasASeat == NORMALIZE_LOBBY_SEATS)
}
module room_owner_seat_before {
  import room_owner_seat(NORMALIZE_LOBBY_SEATS = false, END_ON_NATIVE_LEAVE = false).*
}
module room_owner_seat_fixed {
  import room_owner_seat(NORMALIZE_LOBBY_SEATS = true, END_ON_NATIVE_LEAVE = true).*
}
