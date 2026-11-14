/**
 * Version-mismatch reload guard: a tab older than the server reloads itself
 * once no match is on screen. The logic is web/src/site/version-guard.ts;
 * loaded after the bundle that sets window.KNSite (dist/kn-site.js on the
 * front page, dist/kn-core.js on the play and demo pages).
 */
window.KNSite.startVersionGuard(window);
