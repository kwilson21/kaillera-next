/**
 * Entry point of the front page's bundle (web/static/dist/kn-landing.js). The
 * page is served while the game server sleeps, so this holds no core and no
 * Effect. It reads `window.KNStorage`, which the small site bundle
 * (kn-site.js, loaded before it) sets.
 */
import { startFrontPage } from './landing/front.ts';

startFrontPage(window);
