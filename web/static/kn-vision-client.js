/**
 * Posts this peer's picture of a suspect frame to /api/desync-vision
 * (window.KNVision). The logic is web/src/page/vision-client.ts; loaded after
 * kn-capture.js and dist/kn-core.js, whose desync detector's `desync-capture`
 * events it listens for.
 */
window.KNVision = window.KNCore.page.startVisionClient(window);
