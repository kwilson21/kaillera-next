/**
 * The demo page's own logic, moving here from web/static/demo.js piece by
 * piece. The page reads it as `window.KNCore.demo`.
 */
import * as autopilot from './autopilot.ts';
import * as hud from './hud.ts';
import { createIndicators } from './indicators.ts';
import * as network from './network.ts';
import * as options from './options.ts';
import * as rom from './rom.ts';
import { demoRomStore } from './rom-store.ts';
import { createRunState } from './run-state.ts';
import { createTimelineView } from './timeline-view.ts';
import { createDemoWiring } from './wiring.ts';

export const demo = {
  autopilot,
  hud,
  network,
  options,
  rom,
  romStore: demoRomStore,
  indicators: createIndicators,
  timelineView: createTimelineView,
  runState: createRunState,
  wiring: createDemoWiring,
};
