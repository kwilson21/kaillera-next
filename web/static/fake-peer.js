/**
 * The demo page's synthetic second player (window.KNFakePeer = { start, stop,
 * setNetwork, setMatchActive, getStats }). The logic is
 * web/src/page/fake-peer.ts; loaded after dist/kn-core.js and
 * netplay-rollback.js, and before the engine replaces the browser's timing
 * functions, which the peer takes here.
 */
window.KNFakePeer = window.KNCore.page.startFakePeer(window);
