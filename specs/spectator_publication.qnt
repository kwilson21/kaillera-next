// The rollback host publishes to open spectator channels once its match runs
// and the source canvas is available. Either side of that rendezvous can be first.
module spectator_publication {
  const RECONCILE_ON_START: bool
  var running: bool
  var canvas: bool
  var viewers: Set[int]
  var published: Set[int]
  var audio: bool
  var audible: Set[int]

  action init = all {
    running' = false, canvas' = true, viewers' = Set(), published' = Set(), audio' = false, audible' = Set(),
  }
  action start = all {
    not(running), running' = true, canvas' = canvas, viewers' = viewers,
    published' = if (RECONCILE_ON_START and canvas) viewers else Set(),
    audio' = audio, audible' = if (RECONCILE_ON_START and canvas and audio) viewers else Set(),
  }
  action openViewer(i: int): bool = all {
    not(viewers.contains(i)), viewers' = viewers.union(Set(i)),
    running' = running, canvas' = canvas,
    published' = if (running and canvas) viewers.union(Set(i)) else published,
    audio' = audio, audible' = if (running and canvas and audio) viewers.union(Set(i)) else audible,
  }
  action closeViewer(i: int): bool = all {
    viewers.contains(i), viewers' = viewers.exclude(Set(i)), published' = published.exclude(Set(i)),
    running' = running, canvas' = canvas,
    audio' = audio, audible' = audible.exclude(Set(i)),
  }
  action waitForCanvas = all {
    not(running), canvas' = false, running' = running, viewers' = viewers, published' = published,
    audio' = audio, audible' = audible,
  }
  action canvasArrives = all {
    not(canvas), canvas' = true, running' = running, viewers' = viewers,
    published' = if (running) viewers else Set(),
    audio' = audio, audible' = if (running and audio) viewers else Set(),
  }
  action audioArrives = all {
    not(audio), audio' = true, running' = running, viewers' = viewers, canvas' = canvas, published' = published,
    audible' = if (RECONCILE_ON_START) published else audible,
  }
  action stop = init
  action step = any {
    start, openViewer(1), openViewer(2), closeViewer(1), closeViewer(2), waitForCanvas, canvasArrives, audioArrives, stop,
  }

  val readyViewersPublished = not(running and canvas) or published == viewers
  val onlyOpenViewersPublished = published.subseteq(viewers) and (running or published == Set())
  val audioFollowsVideo = not(audio) or audible == published
  val allHold = readyViewersPublished and onlyOpenViewersPublished and audioFollowsVideo

  run earlyViewerTest = init.then(openViewer(1)).then(start).expect(readyViewersPublished == RECONCILE_ON_START)
  run lateViewerTest = init.then(start).then(openViewer(1)).expect(published == Set(1))
  run noViewersTest = init.then(start).expect(published == Set())
  run soundAfterVideoTest = init.then(start).then(openViewer(1)).expect(published == Set(1) and audible == Set())
    .then(audioArrives).expect(audioFollowsVideo == RECONCILE_ON_START)
}

module spectator_publication_before {
  import spectator_publication(RECONCILE_ON_START = false).*
}

module spectator_publication_fixed {
  import spectator_publication(RECONCILE_ON_START = true).*
  run replaceViewerTest = init.then(openViewer(1)).then(start).then(closeViewer(1))
    .then(openViewer(1)).expect(published == Set(1))
  run canvasAfterLeaveTest = init.then(waitForCanvas).then(openViewer(1)).then(start)
    .then(closeViewer(1)).then(canvasArrives).expect(published == Set())
  run stopBeforeCanvasTest = init.then(waitForCanvas).then(openViewer(1)).then(start).then(stop)
    .expect(published == Set())
}
