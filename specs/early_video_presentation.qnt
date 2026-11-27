// GLideN64 can present a completed alternate color buffer through the VI
// layout. A dirty buffer flag can survive a core frame, including one with
// no swap, so full sync alone does not prove that the buffer is fresh.
module early_video_presentation {
  const REQUIRE_FRESH_DRAW: bool
  const REQUIRE_FORWARD_FRAME: bool

  var s: { frame: int, drawnAt: int, completedAt: int, layout: int,
           replay: bool, headless: bool, shownFrame: int, shownDraw: int,
           shownInReplay: bool, early: bool }

  action init = s' = { frame: 0, drawnAt: -1, completedAt: -1, layout: 0,
                       replay: false, headless: false, shownFrame: -1, shownDraw: -1,
                       shownInReplay: false, early: false }
  val earlyAllowed = not(s.headless) and (not(REQUIRE_FORWARD_FRAME) or not(s.replay))
  action draw(layout: int): bool = s' = { ...s, drawnAt: s.frame, completedAt: -1, layout: layout }
  action sync = all {
    s.drawnAt >= 0,
    s' = if (earlyAllowed and (not(REQUIRE_FRESH_DRAW) or s.drawnAt == s.frame))
      s.with("completedAt", s.frame) else s,
  }
  action nextFrame = s' = s.with("frame", s.frame + 1)
  action scanout(layout: int): bool = {
    val preview = earlyAllowed and s.completedAt == s.frame and s.layout == layout
    s' = if (s.headless) s else
      { ...s, shownFrame: s.frame,
        shownDraw: if (preview) s.drawnAt else -1, shownInReplay: s.replay, early: preview }
  }
  action replay(active: bool): bool = all {
    active != s.replay,
    s' = { ...s, replay: active, headless: active, frame: s.frame + 1 },
  }
  action paintLastReplay = all {
    s.replay, s.headless, s' = s.with("headless", false),
  }
  action step = any {
    draw(0), draw(1), sync, nextFrame, scanout(0), scanout(1), replay(true), replay(false), paintLastReplay,
  }

  val earlyShowsCurrentDraw = not(s.early) or s.shownDraw == s.shownFrame
  val earlyShowsForwardFrame = not(s.early) or not(s.shownInReplay)
  val earlyPresentationSafe = earlyShowsCurrentDraw and earlyShowsForwardFrame

  run completedCurrentDrawTest = init.then(draw(1)).then(sync).then(scanout(1))
    .expect(s.early and earlyShowsCurrentDraw)
  run syncWithoutFreshDrawTest = init.then(draw(1)).then(sync).then(nextFrame)
    .then(sync).then(scanout(1)).expect(earlyShowsCurrentDraw == REQUIRE_FRESH_DRAW)
  run writeAfterSyncTest = init.then(draw(1)).then(sync).then(draw(1)).then(scanout(1))
    .expect(not(s.early))
  run incompatibleLayoutTest = init.then(draw(1)).then(sync).then(scanout(0))
    .expect(not(s.early))
  run replayHoldsPictureTest = init.then(draw(1)).then(sync).then(scanout(1)).then(replay(true))
    .then(draw(1)).then(scanout(1)).expect(s.shownFrame == 0)
    .then(replay(false)).then(scanout(1)).expect(not(s.early))
  run lastReplayPaintUsesViTest = init.then(replay(true)).then(paintLastReplay)
    .then(draw(1)).then(sync).then(scanout(1)).expect((not(s.early)) == REQUIRE_FORWARD_FRAME)
}

module early_video_presentation_before {
  import early_video_presentation(REQUIRE_FRESH_DRAW = false, REQUIRE_FORWARD_FRAME = false).*
}
module early_video_presentation_headless_only {
  import early_video_presentation(REQUIRE_FRESH_DRAW = true, REQUIRE_FORWARD_FRAME = false).*
}
module early_video_presentation_fixed {
  import early_video_presentation(REQUIRE_FRESH_DRAW = true, REQUIRE_FORWARD_FRAME = true).*
}
