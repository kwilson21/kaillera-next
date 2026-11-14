/**
 * The floating feedback button and its form (window.KNFeedback, which
 * play.js calls to prompt after a game). The logic is
 * web/src/site/feedback.ts; loaded after the bundle that sets window.KNSite
 * (dist/kn-site.js on the front page, dist/kn-core.js on the play page).
 */
window.KNFeedback = window.KNSite.startFeedback(window);
