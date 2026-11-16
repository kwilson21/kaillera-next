/**
 * The demo's rollback timeline, as the result card shows it: real engine
 * counters fed each frame to the timeline's state machine
 * (web/src/page/rollback-timeline.ts, which the page has as
 * `window.KNRollbackTimeline`) and drawn into the card's SVG. Moved from
 * web/static/demo.js unchanged in behaviour; demo.js still calls `update`
 * from its HUD loop.
 *
 * The timeline's state is made when the page loads, from whatever
 * `KNRollbackTimeline` the page has then; without it the timeline stays
 * still. Its elements are looked up on the first update that finds them, and
 * kept. Under prefers-reduced-motion the still frame is drawn once and the
 * counters are never fed.
 */
import type { TimelineInput, TimelineRefs, TimelineRenderOptions, TimelineState } from '../page/rollback-timeline.ts';

/** `window.KNRollbackTimeline`, as far as the card uses it. */
export interface TimelineApi {
  readonly createState?: () => TimelineState;
  readonly reduce: (state: TimelineState, input: TimelineInput, now: number) => TimelineState;
  readonly render: (state: TimelineState, refs: TimelineRefs, options?: TimelineRenderOptions) => void;
}

/** The engine's counters the timeline reads (`NetplayRollback.getHudCounters()`). */
export interface TimelineCounters {
  readonly rollbackEventsTotal?: number | null | undefined;
  readonly avgRollbackDepth?: number | null | undefined;
  readonly delay?: number | null | undefined;
}

/** The page: its document, clock, motion preference and timeline. */
export interface TimelinePage {
  readonly document: Document;
  readonly performance: { now(): number };
  readonly matchMedia?: ((query: string) => { readonly matches: boolean } | null | undefined) | undefined;
  readonly KNRollbackTimeline?: TimelineApi | undefined;
}

export const createTimelineView = (page: TimelinePage) => {
  const reducedMotion = page.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  let state = page.KNRollbackTimeline?.createState?.() ?? null;
  let refs: TimelineRefs | null = null;
  let stillRendered = false;

  /** The card's elements: the tick marks in their `data-i` order, the playhead, labels and caption. */
  const findRefs = (): TimelineRefs | null => {
    if (refs) return refs;
    const doc = page.document;
    const svg = doc.getElementById('rb-timeline');
    if (!svg) return null;
    const ticks = Array.from(svg.querySelectorAll<SVGElement>('.t')).sort(
      (a, b) => Number(a.dataset['i'] ?? 0) - Number(b.dataset['i'] ?? 0),
    );
    refs = {
      ticks,
      head: doc.getElementById('rb-head'),
      labelBad: doc.getElementById('rb-lbl-bad'),
      labelReplay: doc.getElementById('rb-lbl-re'),
      caption: doc.getElementById('rb-caption'),
    };
    return refs;
  };

  /** Feed one frame's counters to the timeline and draw it. */
  const update = (
    counters: TimelineCounters | null | undefined,
    inMatch: boolean | null | undefined,
    rollbackEnabled: boolean,
  ): void => {
    const api = page.KNRollbackTimeline;
    if (!api || !state) return;
    const found = findRefs();
    if (!found) return;
    if (reducedMotion) {
      // A still frame: no motion, and the counters are not fed.
      if (!stillRendered) {
        api.render(state, found, { still: true });
        stillRendered = true;
      }
      return;
    }
    state = api.reduce(
      state,
      {
        mode: rollbackEnabled ? 'rollback' : 'lockstep',
        matchActive: !!inMatch,
        rollbackEventsTotal: counters?.rollbackEventsTotal ?? 0,
        avgRollbackDepth: counters?.avgRollbackDepth ?? 0,
        delay: counters?.delay ?? 0,
      },
      page.performance.now(),
    );
    api.render(state, found);
  };

  return { update };
};
