/** Shared EmulatorJS settings for the play and demo pages. */

/** One button's bindings: a keyboard key and a gamepad input. */
interface ControlBinding {
  readonly value: string;
  readonly value2: string;
}

/** EmulatorJS's default controls, per player and button index. */
type DefaultControls = { [player: number]: { [button: number]: ControlBinding } };

/** Player 1 on the keyboard and a standard gamepad; the other players unbound. A new object each time, as EmulatorJS may change it. */
const defaultControls = () =>
  ({
    0: {
      0: { value: 'c', value2: 'BUTTON_2' },
      1: { value: 'x', value2: 'BUTTON_4' },
      3: { value: 'v', value2: 'START' },
      4: { value: 'up arrow', value2: 'DPAD_UP' },
      5: { value: 'down arrow', value2: 'DPAD_DOWN' },
      6: { value: 'left arrow', value2: 'DPAD_LEFT' },
      7: { value: 'right arrow', value2: 'DPAD_RIGHT' },
      10: { value: 't', value2: 'LEFT_TOP_SHOULDER' },
      11: { value: 'y', value2: 'RIGHT_TOP_SHOULDER' },
      12: { value: 'z', value2: 'LEFT_BOTTOM_SHOULDER' },
      16: { value: 'd', value2: 'LEFT_STICK_X:+1' },
      17: { value: 'a', value2: 'LEFT_STICK_X:-1' },
      18: { value: 's', value2: 'LEFT_STICK_Y:+1' },
      19: { value: 'w', value2: 'LEFT_STICK_Y:-1' },
      20: { value: 'j', value2: 'RIGHT_STICK_X:+1' },
      21: { value: 'l', value2: 'RIGHT_STICK_X:-1' },
      22: { value: 'k', value2: 'RIGHT_STICK_Y:+1' },
      23: { value: 'i', value2: 'RIGHT_STICK_Y:-1' },
      24: { value: '', value2: '' },
      25: { value: '', value2: '' },
      26: { value: '', value2: '' },
    },
    1: {},
    2: {},
    3: {},
  }) satisfies DefaultControls;

/** The texture uploads the shim wraps. */
const UPLOADS = ['texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D'] as const;

/** The context a wrapped upload runs on: it sets the alignment before the upload. */
interface UploadContext {
  pixelStorei(pname: number, param: number): void;
  readonly UNPACK_ALIGNMENT: number;
}

/** An upload method: WebGL's return nothing, and the wrapper hands back whatever the original returned. */
type Upload = (this: UploadContext, ...args: never[]) => undefined;

/** A WebGL context prototype, as far as the shim reads and writes it. */
type GlPrototype = Partial<Record<(typeof UPLOADS)[number], Upload>> & { __knUnpackAlignmentPatched?: boolean };

/** Whether a prototype's member is a method the shim can wrap. */
const isUpload = (member: GlPrototype[(typeof UPLOADS)[number]]): member is Upload => typeof member === 'function';

/** The window members the pages set for EmulatorJS, and the WebGL constructors the shim patches. */
export interface EjsPage {
  EJS_player?: string;
  EJS_core?: string;
  EJS_gameID?: string;
  EJS_startOnLoaded?: boolean;
  EJS_pathtodata?: string;
  EJS_defaultOptions?: { [option: string]: string };
  EJS_forceLegacyCores?: boolean;
  EJS_defaultControls?: DefaultControls;
  __knInstallUnpackAlignmentShim?: () => void;
  WebGLRenderingContext?: { readonly prototype: GlPrototype } | undefined;
  WebGL2RenderingContext?: { readonly prototype: GlPrototype } | undefined;
}

/** Make every texture upload on the page's WebGL contexts set UNPACK_ALIGNMENT to 1 first. */
const installUnpackAlignmentShim = (page: EjsPage): void => {
  for (const ctor of [page.WebGLRenderingContext, page.WebGL2RenderingContext]) {
    const proto = ctor?.prototype;
    if (!proto || proto.__knUnpackAlignmentPatched) continue;
    proto.__knUnpackAlignmentPatched = true;
    for (const name of UPLOADS) {
      const original = proto[name];
      if (!isUpload(original)) continue;
      proto[name] = function (this: UploadContext, ...args: never[]): undefined {
        try {
          this.pixelStorei(this.UNPACK_ALIGNMENT, 1);
        } catch {
          // A context that refuses the alignment still gets the upload.
        }
        return original.apply(this, args);
      };
    }
  }
};

/** Put EmulatorJS's settings for the address `search` on the page. */
export const installEjsGlobals = (page: EjsPage, search: string, gameId: string): void => {
  page.EJS_player = '#game';
  page.EJS_core = 'n64';
  page.EJS_gameID = gameId;
  page.EJS_startOnLoaded = true;
  page.EJS_pathtodata = '/static/ejs/';
  page.EJS_defaultOptions = { 'mupen64plus-cpucore': 'cached_interpreter' };
  page.__knInstallUnpackAlignmentShim = () => installUnpackAlignmentShim(page);
  applyEjsGraphicsProfile(page, new URLSearchParams(search).get('kngfx'));
  page.EJS_defaultControls = defaultControls();
};

export const applyEjsGraphicsProfile = (page: EjsPage, profile: string | null): void => {
  const options: [string, string][] = [];
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
  if (profile === 'webgl1') page.EJS_forceLegacyCores = true;
  if (profile === 'unpack1') page.__knInstallUnpackAlignmentShim?.();
  Object.assign((page.EJS_defaultOptions ??= {}), Object.fromEntries(options));
};
