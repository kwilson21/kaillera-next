/**
 * Entry point of the invite page's bundle (web/static/dist/kn-join.js). The
 * page is served while the game server sleeps, so it loads this and the
 * waking art and nothing else: no core, no Effect.
 */
import { startJoinPage } from './landing/join.ts';

startJoinPage(window);
