/**
 * The floating feedback button and its form (window.KNFeedback, which
 * play.js calls to prompt after a game). The logic is
 * web/src/site/feedback.ts; loaded after the bundle that sets window.KNSite
 * (dist/kn-site.js on the front page, dist/kn-core.js on the play page).
 *
 * During a deploy a page can get this file with the previous bundle, whose
 * KNSite has no startFeedback yet: that page goes without the feedback button
 * for one load instead of throwing. play.js already allows for no KNFeedback.
 */
window.KNFeedback = window.KNSite?.startFeedback?.(window);
