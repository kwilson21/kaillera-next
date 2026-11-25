// The page can outlive a deployment. A legacy report or cache tag is not
// evidence that the stored archive has the identity the page will advertise.
module core_archive {
  const PIN_ARCHIVE: bool
  var s: { installed: int, selected: int, cached: int, started: int,
           usedUnknownCache: bool, finished: bool, worker: bool }

  // -1 = before selection, 0 = metadata unavailable. The legacy cache may
  // contain release 1 under a label shared with release 2. A verified cache
  // entry can only have been written by the checked download route.
  action init = s' = { installed: 1, selected: -1, cached: 0,
                       started: 0, usedUnknownCache: false, finished: false, worker: false }
  action deploy = all { s.installed == 1, s' = s.with("installed", 2) }
  action chooseArchive(known: bool): bool = all { s.selected == -1,
    s' = s.with("selected", if (known) s.installed else 0) }
  action legacyCache = all { s.selected >= 0, not(s.finished),
    s' = if (PIN_ARCHIVE) s else { ...s, started: 1, usedUnknownCache: s.selected == 0, finished: true } }
  action download = all { s.selected >= 0, not(s.finished),
    val accepted = not(PIN_ARCHIVE) or (s.selected == 0 and not(s.worker)) or s.selected == s.installed
    s' = { ...s, started: if (accepted) s.installed else 0,
           cached: if (accepted and s.selected > 0) s.installed else 0, finished: true } }
  // The optional replay worker starts later, with the boot's selected build.
  action startWorker = all { s.finished, s.started > 0, not(s.worker),
    s' = { ...s, worker: true, started: 0, finished: false } }
  action reboot = all { s.finished,
    s' = { ...s, selected: -1, started: 0, usedUnknownCache: false, finished: false, worker: false } }
  action checkedCache = all { s.selected > 0, s.cached == s.selected, not(s.finished),
    s' = { ...s, started: s.cached, finished: true } }
  action step = any { deploy, chooseArchive(true), chooseArchive(false), legacyCache, download, startWorker, reboot, checkedCache, s' = s }

  val startedArchiveMatches = s.selected <= 0 or s.started == 0 or s.started == s.selected
  val unknownSkipsCache = not(s.usedUnknownCache)
  val workerHasKnownIdentity = not(s.worker) or s.started == 0 or s.selected > 0
  val allHold = startedArchiveMatches and unknownSkipsCache and workerHasKnownIdentity

  run deployAfterSelectionTest = init.then(chooseArchive(true)).then(deploy).then(download)
    .expect(startedArchiveMatches == PIN_ARCHIVE)
  run staleReportAndOldCacheTest = init.then(deploy).then(chooseArchive(true)).then(legacyCache)
    .expect(startedArchiveMatches == PIN_ARCHIVE)
  run metadataOutageTest = init.then(chooseArchive(false)).then(legacyCache).expect(unknownSkipsCache == PIN_ARCHIVE)
  run unversionedDownloadTest = init.then(chooseArchive(false)).then(deploy).then(download).expect(s.started == 2 and s.cached == 0)
  run workerStartsAfterDeploymentTest = init.then(chooseArchive(true)).then(download).then(deploy).then(startWorker).then(download)
    .expect(startedArchiveMatches == PIN_ARCHIVE)
  run workerNeedsIdentityTest = init.then(chooseArchive(false)).then(download).then(startWorker).then(download)
    .expect(workerHasKnownIdentity == PIN_ARCHIVE)
  run verifiedReuseTest = init.then(chooseArchive(true)).then(download).then(reboot).then(chooseArchive(true)).then(checkedCache).expect(s.started == 1)
}
module core_archive_before { import core_archive(PIN_ARCHIVE = false).* }
module core_archive_fixed { import core_archive(PIN_ARCHIVE = true).* }
