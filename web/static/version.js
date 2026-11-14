/**
 * The version in the page footer, the changelog it opens, and the About
 * window. The logic is web/src/site/version.ts; loaded after the bundle that
 * sets window.KNSite (dist/kn-site.js on the front page, dist/kn-core.js on
 * the play page).
 */
window.KNSite.startVersion(window);
