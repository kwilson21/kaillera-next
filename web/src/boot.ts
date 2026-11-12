/**
 * When the engine gives up waiting for the emulator to boot.
 *
 * The boot loop polls every 100 ms for the core to run its first frames. It
 * used to give up after a fixed 300 polls (30 s) whatever the core was doing,
 * which stranded a device that was booting slowly but steadily. Now a core
 * that is still producing frames keeps its wait, up to a hard cap; one that
 * has stopped gets the same 30 s as before.
 */

/** Polls (about 30 s) a boot may take without having to show progress. */
export const BOOT_POLL_BUDGET = 300;
/** Past the budget, a boot counts as progressing if a frame arrived this recently. */
export const BOOT_PROGRESS_WINDOW_MS = 5_000;
/** No boot waits longer than this in total, progressing or not. */
export const BOOT_HARD_CAP_MS = 180_000;

export interface BootWait {
  /** Polls made since the boot gesture. */
  readonly polls: number;
  /** Time since polling began. */
  readonly elapsedMs: number;
  /** Time since the core's frame count last advanced. */
  readonly sinceProgressMs: number;
}

/** True when the boot loop should stop and tell the player the emulator failed. */
export const bootTimedOut = ({ polls, elapsedMs, sinceProgressMs }: BootWait): boolean => {
  if (polls <= BOOT_POLL_BUDGET) return false;
  if (elapsedMs >= BOOT_HARD_CAP_MS) return true;
  return sinceProgressMs >= BOOT_PROGRESS_WINDOW_MS;
};
