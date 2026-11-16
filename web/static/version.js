/**
 * The version in the page footer, the changelog it opens, and the About
 * window. The logic is web/src/site/version.ts; loaded after the bundle that
 * sets window.KNSite (dist/kn-site.js on the front page, dist/kn-core.js on
 * the play page).
 *
 * During a deploy a page can get this file with the previous bundle, whose
 * KNSite has no startVersion yet: that page goes without the footer version
 * for one load instead of throwing.
 */
window.KNSite?.startVersion?.(window);
