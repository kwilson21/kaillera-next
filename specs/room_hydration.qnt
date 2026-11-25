// A configured store holds a room from before the process restarted. A failed
// read must not publish an empty lobby or accept rooms without persistence.
module room_hydration {
  const REQUIRE_HYDRATION: bool
  var boot: { configured: bool, phase: str, restored: bool }

  action initial(configured: bool): bool = boot' = {
    configured: configured, phase: if (configured) "starting" else "ready", restored: false,
  }
  action init = any { initial(true), initial(false) }
  action readStore(complete: bool): bool = all {
    boot.phase == "starting",
    boot' = boot.with("phase", if (complete or not(REQUIRE_HYDRATION)) "ready" else "starting")
                .with("restored", complete),
  }
  action step = any { readStore(false), readStore(true), boot' = boot }
  val readyIncludesSavedRooms = boot.phase != "ready" or not(boot.configured) or boot.restored
  val allHold = readyIncludesSavedRooms
  run storeUnavailableTest = initial(true).then(readStore(false))
    .expect(readyIncludesSavedRooms == REQUIRE_HYDRATION)
  run ephemeralTest = initial(false).expect(boot.phase == "ready")
}
module room_hydration_before {
  import room_hydration(REQUIRE_HYDRATION = false).*
}
module room_hydration_fixed {
  import room_hydration(REQUIRE_HYDRATION = true).*
}
