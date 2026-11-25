// A local preview of the native pause/reset affordance, never game-state writes.
// 12CB's first chord requests reset and transfers pause control; a second,
// deliberate chord from the new controller approves. If the opponent is CPU,
// ownership stays put, but the request phase still changes and must rearm.
module contextual_reset {
  const FIXED: bool
  type State = { paused: bool, supported: bool, owner: int, phase: int, scope: int,
    heldScope: int, visible: bool, held: bool, waited: bool, physical: Set[int],
    toolbar: bool, dialog: bool, resumeGuard: bool }
  var s: State
  pure def eligible(x) = x.paused and x.supported and x.owner == 0
  pure def refresh(x) = if (FIXED) x.with("visible", false).with("held", false).with("waited", false) else x
  action init = s' = { paused: false, supported: true, owner: 0, phase: 0, scope: 0,
    heldScope: -1, visible: false, held: false, waited: false, physical: Set(0), toolbar: false, dialog: false, resumeGuard: false }
  action pause = s' = refresh(s.with("paused", true).with("scope", s.scope + 1))
  action delay = s' = s.with("visible", eligible(s)).with("waited", true)
  action press = s' = s.with("held", s.visible and eligible(s)).with("heldScope", s.scope)
  action release = s' = s.with("held", false)
  action requestHuman = s' = refresh(s.with("phase", 1).with("owner", 1).with("scope", s.scope + 1))
  action requestCpu = s' = refresh(s.with("phase", 1).with("scope", s.scope + 1))
  action unpause = s' = refresh(s.with("paused", false).with("scope", s.scope + 1))
  action unknown = s' = refresh(s.with("supported", false).with("scope", s.scope + 1))
  action newMatch = s' = refresh(s.with("scope", s.scope + 1))
  action openToolbar = s' = s.with("toolbar", true)
  action openDialog = s' = s.with("dialog", true)
  action focusReturn = s' = s.with("resumeGuard", true)
  action pointerPress = s' = s.with("held", s.visible and eligible(s)).with("heldScope", s.scope)
    .with("resumeGuard", s.resumeGuard or not(FIXED))
  action step = any { pause, delay, press, release, requestHuman, requestCpu, unpause, unknown, newMatch,
    openToolbar, openDialog, focusReturn, pointerPress }
  val sendsChord = s.held and not(s.dialog) and not(s.resumeGuard) and (FIXED or not(s.toolbar))
  val output = s.physical.union(if (sendsChord) Set(0, 1, 11, 12) else Set())
  val safeHold = s.held implies (eligible(s) and s.visible and s.waited and s.heldScope == s.scope)
  val physicalPreserved = s.physical.subseteq(output)
  run noShortcutBeforeDelayTest = init.then(pause).then(press).expect(not(s.held))
  run pointerPressSendsImmediatelyTest = init.then(pause).then(delay).then(pointerPress).expect(sendsChord == FIXED)
  run toolbarDoesNotBlockShortcutTest = init.then(pause).then(delay).then(openToolbar).then(press).expect(sendsChord == FIXED)
  run dialogBlocksShortcutTest = init.then(pause).then(delay).then(openDialog).then(press).expect(not(sendsChord))
  run pointerDoesNotClearExistingGuardTest = init.then(pause).then(delay).then(focusReturn).then(pointerPress).expect(not(sendsChord))
  run normalHoldTest = init.then(pause).then(delay).then(press).expect(s.held)
  run humanApprovalRearmsTest = init.then(pause).then(delay).then(press).then(requestHuman).expect(not(s.held) == FIXED)
  run cpuApprovalAlsoRearmsTest = init.then(pause).then(delay).then(press).then(requestCpu).expect(not(s.held) == FIXED)
  run unpauseReleasesTest = init.then(pause).then(delay).then(press).then(unpause).expect(not(s.held) == FIXED)
  run unknownDisablesTest = init.then(pause).then(delay).then(press).then(unknown).expect(not(s.held) == FIXED)
  run rematchRearmsTest = init.then(pause).then(delay).then(press).then(newMatch).expect(not(s.held) == FIXED)
}
module contextual_reset_before { import contextual_reset(FIXED = false).* }
module contextual_reset_fixed { import contextual_reset(FIXED = true).* }
