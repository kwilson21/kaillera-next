/**
 * Version-mismatch reload guard: a tab older than the server reloads itself
 * once its match ends. The logic is web/src/site/version-guard.ts;
 * loaded after the bundle that sets window.KNSite (dist/kn-site.js on the
 * front page, dist/kn-core.js on the play and demo pages).
 *
 * A page whose HTML predates that order (served by an older instance during
 * a deploy) runs this before its bundle. Such a page is exactly the stale
 * one the guard exists for, so it starts once the page's scripts have run.
 */
(() => {
  const start = () => window.KNSite?.startVersionGuard(window);
  if (window.KNSite) start();
  else window.addEventListener('DOMContentLoaded', start);
})();
