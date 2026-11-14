/**
 * What the demo page's address asks for: recording, a random player 1, no
 * auto-compare, and a graphics profile for the emulator. Moved from
 * web/static/demo.js unchanged in behaviour; a value the page does not know
 * is treated as if the parameter were absent, as it always was.
 */

/** Whose inputs `?record=` captures (`1` is player 1, `p2` player 2); false when the page is not recording. */
export type RecordMode = 'p1' | 'p2' | false;

/** The demo's options, read once as the page loads. */
export type DemoOptions = {
  readonly record: RecordMode;
  /** `?randomP1=1` (or `demoRandomP1`, `p1Random`): player 1 presses random buttons during a match. */
  readonly randomP1InMatch: boolean;
  /** `?autoCompare=0`: a match stays on rollback instead of flipping to lockstep and back. */
  readonly autoCompareDisabled: boolean;
};

/** The options in a query string (`location.search`). */
export const demoOptions = (search: string): DemoOptions => {
  const params = new URLSearchParams(search);
  const record = params.get('record');
  return {
    record: record === '1' ? 'p1' : record === 'p2' ? 'p2' : false,
    randomP1InMatch:
      params.get('randomP1') === '1' || params.get('demoRandomP1') === '1' || params.get('p1Random') === '1',
    autoCompareDisabled: params.get('autoCompare') === '0',
  };
};

/** What the page sets on `window` for EmulatorJS before the emulator loads. */
export type EjsSettings = {
  /** `EJS_defaultOptions`, in the order the page has always written them. */
  readonly defaultOptions: { [option: string]: string };
  /** Set `EJS_forceLegacyCores` (the WebGL 1 profile); the page never clears it. */
  readonly forceLegacyCores: boolean;
  /** Install the texture-upload alignment shim (`?kngfx=unpack1`). */
  readonly unpackAlignmentShim: boolean;
};

/** The emulator settings for the `?kngfx=` graphics profile in a query string. */
export const ejsSettings = (search: string): EjsSettings => {
  const profile = new URLSearchParams(search).get('kngfx');
  const options: [string, string][] = [['mupen64plus-cpucore', 'cached_interpreter']];
  if (profile === 'texrect') {
    options.push(
      ['mupen64plus-EnableNativeResTexrects', 'Optimized'],
      ['mupen64plus-EnableTexCoordBounds', 'True'],
      ['mupen64plus-CorrectTexrectCoords', 'Force'],
    );
  } else if (profile === 'texrect-unopt') {
    options.push(
      ['mupen64plus-EnableNativeResTexrects', 'Unoptimized'],
      ['mupen64plus-EnableTexCoordBounds', 'True'],
      ['mupen64plus-CorrectTexrectCoords', 'Force'],
      ['mupen64plus-BackgroundMode', 'Stripped'],
    );
  } else if (profile === 'webgl1') {
    options.push(['webgl2Enabled', 'disabled']);
  } else if (profile === 'angrylion') {
    options.push(['mupen64plus-rdp-plugin', 'angrylion']);
  } else if (profile === 'parallel') {
    options.push(['mupen64plus-rdp-plugin', 'parallel']);
  }
  return {
    defaultOptions: Object.fromEntries(options),
    forceLegacyCores: profile === 'webgl1',
    unpackAlignmentShim: profile === 'unpack1',
  };
};
