// Reset is ordinary controller input, never a local emulator state mutation.
// The shortcut owns its chord separately from real held controls. Closing,
// canceling, blur, game end and release all stop the shortcut, not other input.
module reset_combo {
  var open: bool
  var held: bool
  var playing: bool
  var physical: Set[int]
  val chord = Set(0, 1, 11, 12)
  val sampled = physical.union(if (open and held and playing) chord else Set())
  action init = all { open' = false, held' = false, playing' = true, physical' = Set() }
  action show = all { open' = playing, held' = false, playing' = playing, physical' = physical }
  action press = all { open' = open, held' = (open and playing), playing' = playing, physical' = physical }
  action release = all { open' = open, held' = false, playing' = playing, physical' = physical }
  action close = all { open' = false, held' = false, playing' = playing, physical' = physical }
  action end = all { open' = false, held' = false, playing' = false, physical' = physical }
  action touch = {
    nondet button = oneOf(Set(0, 1, 3, 11, 12))
    all { open' = open, held' = held, playing' = playing, physical' = if (physical.contains(button)) physical.exclude(Set(button)) else physical.union(Set(button)) }
  }
  action step = any { show, press, release, close, end, touch }
  val otherInputPreserved = physical.subseteq(sampled)
  val releasedMeansNoShortcut = (not(held) or not(open) or not(playing)) implies sampled == physical
  run releaseKeepsTouchTest = init.then(touch).then(show).then(press).then(release).expect(sampled == physical)
  run closeClearsTest = init.then(show).then(press).then(close).expect(sampled == physical)
}
