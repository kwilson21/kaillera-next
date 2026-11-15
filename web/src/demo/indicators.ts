/**
 * The demo's two floating badges: the input indicator (inputs off while the
 * autopilot drives the menus, inputs back on, the match is over) and the
 * REC badge while a recording runs. Moved from web/static/demo.js unchanged
 * in behaviour; demo.js still decides when each shows. Their text, colours
 * and animations are hud.ts's.
 *
 * The input indicator is made anew for each state: changing one element in
 * place let its pulse and fade animations fight, which showed as a flash.
 * The REC badge adds its keyframes each time it appears, as it always did.
 */
import { INPUT_INDICATOR_CSS, INPUT_INDICATOR_KEYFRAMES, inputIndicator } from './hud.ts';

const REC_CSS =
  'position:fixed;top:12px;right:12px;z-index:9999;' +
  'padding:6px 12px;border-radius:6px;background:#a02020;color:#fff;' +
  'font-family:sans-serif;font-weight:800;font-size:13px;letter-spacing:0.08em;' +
  'box-shadow:0 0 0 0 rgba(255,80,80,0.6);animation:recPulse 1.4s ease-in-out infinite;' +
  'pointer-events:none;';

const REC_KEYFRAMES =
  '@keyframes recPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,80,80,0.6)}50%{box-shadow:0 0 0 12px rgba(255,80,80,0)}}';

/** The page the badges go on, and its timers: the window. */
export interface IndicatorPage {
  readonly document: Document;
  setTimeout(run: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const createIndicators = (page: IndicatorPage) => {
  let inputTimer: number | null = null;

  const ensureInputKeyframes = (): void => {
    const doc = page.document;
    if (doc.getElementById('kn-demo-indicator-anim')) return;
    const style = doc.createElement('style');
    style.id = 'kn-demo-indicator-anim';
    style.textContent = INPUT_INDICATOR_KEYFRAMES;
    doc.head.appendChild(style);
  };

  /** Show the input indicator for `state` ('disabled', 'enabled', 'post-match'), or remove it. */
  const showInput = (state: string | null | undefined): void => {
    const doc = page.document;
    if (inputTimer) {
      page.clearTimeout(inputTimer);
      inputTimer = null;
    }
    doc.getElementById('input-indicator')?.remove();
    if (!state) return;
    ensureInputKeyframes();
    const el = doc.createElement('div');
    el.id = 'input-indicator';
    el.style.cssText = INPUT_INDICATOR_CSS;
    const look = inputIndicator(state);
    if (look) {
      el.textContent = look.text;
      el.style.background = look.background;
      el.style.animation = look.animation;
      if (look.removeAfterMs != null) {
        inputTimer = page.setTimeout(() => {
          doc.getElementById('input-indicator')?.remove();
          inputTimer = null;
        }, look.removeAfterMs);
      }
    }
    doc.body.appendChild(el);
  };

  /** Show the REC badge, or remove it. */
  const showRec = (on: boolean): void => {
    const doc = page.document;
    const el = doc.getElementById('rec-indicator');
    if (on && !el) {
      const badge = doc.createElement('div');
      badge.id = 'rec-indicator';
      badge.textContent = '● REC';
      badge.style.cssText = REC_CSS;
      const style = doc.createElement('style');
      style.textContent = REC_KEYFRAMES;
      doc.head.appendChild(style);
      doc.body.appendChild(badge);
    } else if (!on && el) {
      el.remove();
    }
  };

  return { showInput, showRec };
};
