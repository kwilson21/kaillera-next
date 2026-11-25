// play.js and the Streaming engine can request the same emulator boot while
// core selection is pending. A match/ROM change also invalidates work already
// inside ejs-loader.js, whose imports and language fetch are asynchronous.
module emulator_boot {
  const OWN_BOOT: bool
  var boot: { epoch: int, preparing: List[int], loaders: List[int], running: List[int] }
  action init = boot' = { epoch: 1, preparing: [], loaders: [], running: [] }
  action request = boot' = if (boot.running.length() > 0 or
      (OWN_BOOT and (boot.preparing.indices().exists(i => boot.preparing[i] == boot.epoch) or
       boot.loaders.indices().exists(i => boot.loaders[i] == boot.epoch))))
    boot else boot.with("preparing", boot.preparing.append(boot.epoch))
  action prepared = all {
    boot.preparing.length() > 0,
    val e = boot.preparing.head()
    boot' = boot.with("preparing", boot.preparing.tail()).with("loaders",
      if (not(OWN_BOOT) or e == boot.epoch) boot.loaders.append(e) else boot.loaders)
  }
  action loaded = all {
    boot.loaders.length() > 0,
    val e = boot.loaders.head()
    boot' = boot.with("loaders", boot.loaders.tail()).with("running",
      if (not(OWN_BOOT) or e == boot.epoch) boot.running.append(e) else boot.running)
  }
  action teardown = boot' = boot.with("epoch", boot.epoch + 1).with("running", [])
  action step = any { request, prepared, loaded, teardown }
  val oneCurrentEmulator = boot.running == [] or boot.running == [boot.epoch]
  run concurrentStartsTest = init.then(request).then(request).then(prepared).then(loaded)
    .then(if (OWN_BOOT) boot' = boot else prepared.then(loaded)).expect(oneCurrentEmulator == OWN_BOOT)
  run cancelledPreparationTest = init.then(request).then(teardown).then(request).then(prepared)
    .expect(boot.loaders.length() == (if (OWN_BOOT) 0 else 1))
  run cancelledLoaderTest = init.then(request).then(prepared).then(teardown).then(request).then(loaded)
    .expect(oneCurrentEmulator == OWN_BOOT)
}
module emulator_boot_before { import emulator_boot(OWN_BOOT = false).* }
module emulator_boot_fixed { import emulator_boot(OWN_BOOT = true).* }
