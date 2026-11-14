/**
 * The globals other plain scripts and EmulatorJS put on `window`, as far as
 * the shared utilities read them. Each is typed here only as far as it is
 * used, and read when needed, never when the bundle loads: most of them do
 * not exist yet at that point.
 */
import type { WireInput } from '../input-wire.ts';

/** The WASM core's exports the shared utilities call. */
export interface EmulatorModule {
  _get_current_frame_count?: () => number;
  SDL2?: { audioContext?: { state: string } };
  _reset_cheat?: () => void;
  _kn_write_controller?: (slot: number, buttons: number, lx: number, ly: number, cx: number, cy: number) => void;
  _kn_netplay_simulate_input?: (slot: number, index: number, value: number) => void;
  _simulate_input?: (slot: number, index: number, value: number) => void;
}

/** EmulatorJS's game manager. */
export interface GameManager {
  Module?: EmulatorModule;
  setCheat: (index: number, enabled: number, code: string) => void;
  resetCheat?: () => void;
  setKeyboardEnabled: (enabled: boolean) => void;
}

/** A game manager whose core has loaded. */
export interface RunningGameManager extends GameManager {
  Module: EmulatorModule;
}

/** One EmulatorJS control binding: `value` is the keyCode bound to the button. */
interface ControlBinding {
  value?: number;
}

/** `window.EJS_emulator`. */
export interface Emulator {
  gameManager?: GameManager;
  /** Per player, button index to binding. */
  controls?: Record<string, Record<string, ControlBinding | null | undefined> | undefined>;
  touch?: boolean;
  virtualGamepad?: HTMLElement;
  settingsMenuOpen?: boolean;
  isPopupOpen?: () => boolean;
  elements?: { menu?: Element; parent?: HTMLElement };
  gamepad?: {
    timeout?: ReturnType<typeof setTimeout>;
    loop: () => void;
    getGamepads: () => Gamepad[];
    updateGamepadState: () => void;
  };
}

export interface SharedGlobals {
  EJS_emulator?: Emulator;
  EJS_cheats?: string[];
  /** web/static/gamepad-manager.js */
  GamepadManager?: { readGamepad: (slot: number) => WireInput | null | undefined };
  /** web/static/api-sandbox.js */
  APISandbox?: { overrideGetGamepads?: (read: () => Gamepad[]) => void };
  /** The boot trace play.js installs. */
  _knBootLog?: (event: string, detail?: Record<string, string | number | boolean>) => void;
  /** Set by play.js for a spectator: their connections go through TURN only. */
  _isSpectator?: boolean;
  /** Set by the engines once they have replaced EmulatorJS's touch controls. */
  _kn_ejsTouchDisabled?: boolean;
  _kn_preloadedAudioCtx?: { state: string };
  /** performance.now() until which each local input read is logged. */
  _debugInputUntil?: number;
}

// SAFETY: these are properties other scripts add to `window` at run time,
// which its DOM type does not list. Every one is optional here and checked
// where it is read.
export const page = (): Window & SharedGlobals => window as Window & SharedGlobals;
