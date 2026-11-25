// A configured store holds a room from before the process restarted. A failed
// read must not publish an empty lobby or accept rooms without persistence.
module room_hydration {
  const REQUIRE_HYDRATION: bool
  const RESTORE_AFTER_DB: bool
  var boot: { configured: bool, phase: str, restored: bool, dbReady: bool,
              lateRoom: bool, restoredLateRoom: bool }

  action initial(configured: bool): bool = boot' = {
    configured: configured, phase: if (configured) "starting" else "ready", restored: false,
    dbReady: false, lateRoom: false, restoredLateRoom: false,
  }
  action init = any { initial(true), initial(false) }
  // The serving process can save another room while its replacement opens the database.
  action openDb(roomWritten: bool): bool = all {
    boot.configured, not(boot.dbReady),
    boot' = boot.with("dbReady", true).with("lateRoom", roomWritten)
                .with("phase", if (boot.phase == "read") "ready" else boot.phase),
  }
  action readStore(complete: bool): bool = all {
    boot.phase == "starting", boot.dbReady or not(RESTORE_AFTER_DB),
    boot' = boot.with("phase", if (complete or not(REQUIRE_HYDRATION))
                    (if (boot.dbReady) "ready" else "read") else "starting")
                .with("restored", complete).with("restoredLateRoom", complete and boot.lateRoom),
  }
  action step = any { openDb(false), openDb(true), readStore(false), readStore(true), boot' = boot }
  val readyIncludesSavedRooms = boot.phase != "ready" or not(boot.configured) or boot.restored
  val readyIncludesRoomSavedDuringStartup = boot.phase != "ready" or not(boot.lateRoom) or boot.restoredLateRoom
  val allHold = readyIncludesSavedRooms and readyIncludesRoomSavedDuringStartup
  run storeUnavailableTest = initial(true).then(openDb(false)).then(readStore(false))
    .expect(readyIncludesSavedRooms == REQUIRE_HYDRATION)
  run roomSavedDuringStartupTest = if (RESTORE_AFTER_DB)
    initial(true).then(openDb(true)).then(readStore(true)).expect(readyIncludesRoomSavedDuringStartup)
  else
    initial(true).then(readStore(true)).then(openDb(true)).expect(not(readyIncludesRoomSavedDuringStartup))
  run ephemeralTest = initial(false).expect(boot.phase == "ready")
}
module room_hydration_before {
  import room_hydration(REQUIRE_HYDRATION = false, RESTORE_AFTER_DB = false).*
}
module room_hydration_before_order_fix {
  import room_hydration(REQUIRE_HYDRATION = true, RESTORE_AFTER_DB = false).*
}
module room_hydration_fixed {
  import room_hydration(REQUIRE_HYDRATION = true, RESTORE_AFTER_DB = true).*
}
