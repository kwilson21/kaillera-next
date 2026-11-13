/**
 * The arithmetic of the freeze and render diagnostics
 * (web/static/kn-diagnostics.js): what a canvas's pixels hash to, whether
 * they look like the solid pale frame of a broken renderer, which part of
 * the canvas a screenshot takes, and what an audio state change means.
 *
 * kn-diagnostics.js reads the pixels and the audio state from the browser
 * and writes the log lines; these functions are given the numbers. None of
 * this feeds the emulator or the netplay engine: it only decides what is
 * logged and reported.
 */

/**
 * A hash of RGBA pixels for the RENDER-STALL detector: FNV-1a over the top
 * four bits of red, green and blue of every sixteenth pixel. Coarse on
 * purpose, so that dithering noise on a frozen frame does not look like
 * movement.
 */
export function hashPixels(rgba: ArrayLike<number>): number {
  let hash = 2166136261;
  const stride = 16 * 4;
  for (let i = 0; i < rgba.length; i += stride) {
    hash = Math.imul(hash ^ ((rgba[i] ?? 0) >> 4), 16777619) >>> 0;
    hash = Math.imul(hash ^ ((rgba[i + 1] ?? 0) >> 4), 16777619) >>> 0;
    hash = Math.imul(hash ^ ((rgba[i + 2] ?? 0) >> 4), 16777619) >>> 0;
  }
  return hash;
}

/** What a small sample of the game canvas looks like, in numbers. */
export interface CanvasHealth {
  meanR: number;
  meanG: number;
  meanB: number;
  brightness: number;
  /** Standard deviation over all three channels, to one decimal. */
  stdev: number;
  /** Brightest channel value minus darkest, over the whole sample. */
  range: number;
  /** Share of pixels that are pale with a green tint, to three decimals. */
  paleRatio: number;
  /** Share of pixels that are yellow-green, to three decimals. */
  yellowGreenRatio: number;
  /**
   * The sample is one flat pale or yellow-green colour: what the canvas
   * shows when the renderer came up broken and the game is not being drawn.
   */
  solidPale: boolean;
}

/**
 * Measure a sample of RGBA pixels. `rgba` is `ImageData.data`: four bytes a
 * pixel, so its length is a multiple of four.
 */
export function measureCanvasHealth(rgba: ArrayLike<number>): CanvasHealth {
  const n = rgba.length / 4;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let min = 255;
  let max = 0;
  let palePixels = 0;
  let yellowGreenPixels = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i] ?? 0;
    const g = rgba[i + 1] ?? 0;
    const b = rgba[i + 2] ?? 0;
    sumR += r;
    sumG += g;
    sumB += b;
    if (r < min) min = r;
    if (g < min) min = g;
    if (b < min) min = b;
    if (r > max) max = r;
    if (g > max) max = g;
    if (b > max) max = b;
    if (r >= 200 && g >= 205 && b >= 175 && g >= b + 2 && Math.max(r, g, b) - Math.min(r, g, b) <= 80) {
      palePixels++;
    }
    if (r >= 145 && g >= 145 && b <= 165 && g >= b + 18 && Math.abs(r - g) <= 55) {
      yellowGreenPixels++;
    }
  }
  const meanR = sumR / n;
  const meanG = sumG / n;
  const meanB = sumB / n;
  let variance = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    variance += ((rgba[i] ?? 0) - meanR) ** 2 + ((rgba[i + 1] ?? 0) - meanG) ** 2 + ((rgba[i + 2] ?? 0) - meanB) ** 2;
  }
  const stdev = Math.sqrt(variance / (n * 3));
  const brightness = (meanR + meanG + meanB) / 3;
  const range = max - min;
  const paleRatio = palePixels / n;
  const yellowGreenRatio = yellowGreenPixels / n;
  const solidPale =
    brightness >= 130 &&
    stdev <= 24 &&
    range <= 75 &&
    (paleRatio >= 0.78 || yellowGreenRatio >= 0.82) &&
    meanG >= meanB + 8;
  return {
    meanR: Math.round(meanR),
    meanG: Math.round(meanG),
    meanB: Math.round(meanB),
    brightness: Math.round(brightness),
    stdev: Number(stdev.toFixed(1)),
    range,
    paleRatio: Number(paleRatio.toFixed(3)),
    yellowGreenRatio: Number(yellowGreenRatio.toFixed(3)),
    solidPale,
  };
}

/** A rectangle of the game canvas, in canvas pixels. */
export interface Crop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * The centred 4:3 part of a `width` by `height` canvas that a diagnostic
 * screenshot takes: a wider canvas loses its sides, a taller one its top
 * and bottom.
 */
export function screenshotCrop(width: number, height: number): Crop {
  const targetRatio = 4 / 3;
  const srcRatio = width / height;
  if (srcRatio > targetRatio) {
    const sw = Math.round(height * targetRatio);
    return { sx: Math.round((width - sw) / 2), sy: 0, sw, sh: height };
  }
  if (srcRatio < targetRatio) {
    const sh = Math.round(width / targetRatio);
    return { sx: 0, sy: Math.round((height - sh) / 2), sw: width, sh };
  }
  return { sx: 0, sy: 0, sw: width, sh: height };
}

/**
 * What a change of the AudioContext state means: `stall` when it stops
 * running, `resume` when it runs again after having been seen in another
 * state, and null for anything else (including the first state seen, when
 * `previous` is the empty string).
 */
export function audioTransition(previous: string, current: string): 'stall' | 'resume' | null {
  if (current === previous) return null;
  if (current !== 'running' && previous === 'running') return 'stall';
  if (current === 'running' && previous !== '' && previous !== 'running') return 'resume';
  return null;
}
