// One page's controller assignment and keyboard listener, shared by all match modes.
module local_input {
  const FOLLOW_SEAT: bool
  const REFRESH_ACTIVE: bool
  var s: { seat: int, pads: Set[int], selected: int, assigned: int,
    engine: str, listener: str, savedKey: int, liveKey: int, heldBy: str }

  action init = s' = { seat: 0, pads: Set(), selected: -1, assigned: -1,
    engine: "", listener: "", savedKey: 67, liveKey: 67, heldBy: "" }

  action plug(pad: int): bool = all {
    not(s.pads.contains(pad)),
    val updated = s.with("pads", s.pads.union(Set(pad)))
    s' = if (s.selected < 0) updated.with("selected", pad).with("assigned", s.seat) else updated,
  }
  action unplug(pad: int): bool = all {
    s.pads.contains(pad),
    val left = s.pads.exclude(Set(pad))
    val updated = s.with("pads", left)
    s' = if (s.selected != pad) updated
      else if (left.size() == 0) updated.with("selected", -1).with("assigned", -1)
      else updated.with("selected", if (left.contains(0)) 0 else 1).with("assigned", s.seat),
  }
  action choose(pad: int): bool = all {
    s.pads.contains(pad), s' = s.with("selected", pad).with("assigned", s.seat),
  }
  action roster(seat: int): bool =
    s' = s.with("seat", seat).with("assigned", if (FOLLOW_SEAT and s.selected >= 0) seat else s.assigned)

  action start(mode: str): bool = all {
    s.engine == "", s' = s.with("engine", mode).with("listener", mode)
      .with("liveKey", s.savedKey).with("heldBy", ""),
  }
  action stop = s' = s.with("engine", "").with("listener", "").with("heldBy", "")
  action remap(key: int): bool = {
    val updated = s.with("savedKey", key)
    s' = if (REFRESH_ACTIVE) (if (s.engine != "") updated.with("liveKey", key) else updated)
      else updated.with("listener", "rollback").with("liveKey", if (s.engine == "rollback") key else s.liveKey)
  }
  action keyDown = all { s.engine != "", s' = s.with("heldBy", s.listener) }
  action keyUp = s' = s.with("heldBy", "")
  action step = any {
    nondet pad = oneOf(Set(0, 1))
    any { plug(pad), unplug(pad), choose(pad) },
    nondet seat = oneOf(Set(0, 1, 2, 3))
    roster(seat),
    nondet mode = oneOf(Set("rollback", "streaming"))
    start(mode),
    nondet key = oneOf(Set(67, 81))
    remap(key),
    keyDown, keyUp, stop,
  }

  val usablePad = s.pads.contains(s.selected) and s.assigned == s.seat
  val allHold = (usablePad == (s.pads.size() > 0)) and s.listener == s.engine
    and (s.engine == "" or s.liveKey == s.savedKey) and (s.heldBy == "" or s.heldBy == s.engine)
  run guestSeatTest = init.then(plug(0)).then(plug(1)).then(choose(1)).then(roster(2))
    .expect(s.selected == 1 and usablePad == FOLLOW_SEAT)
  run lastPadRemovedTest = init.then(plug(0)).then(roster(1)).then(unplug(0)).expect(not(usablePad))
  run streamingRebindTest = init.then(start("streaming")).then(remap(81)).then(keyDown)
    .expect((s.heldBy == s.engine and s.liveKey == 81) == REFRESH_ACTIVE)
  run resetHeldInStreamingTest = init.then(start("streaming")).then(remap(81)).then(keyDown)
    .then(remap(67)).expect((s.heldBy == s.engine and s.liveKey == 67) == REFRESH_ACTIVE)
  run nextModeTest = init.then(start("rollback")).then(keyDown).then(stop).then(remap(81))
    .then(start("streaming")).expect(s.heldBy == "" and s.liveKey == 81 and s.listener == "streaming")
}
module local_input_current { import local_input(FOLLOW_SEAT = true, REFRESH_ACTIVE = true).* }
module local_input_previous { import local_input(FOLLOW_SEAT = false, REFRESH_ACTIVE = false).* }
