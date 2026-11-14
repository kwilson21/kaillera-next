/**
 * Posts this peer's picture of a suspect frame to /api/desync-vision
 * (window.KNVision). The logic is web/src/page/vision-client.ts; loaded after
 * kn-capture.js and kn-desync-detector.js, whose `desync-capture` events it
 * listens for.
 */
window.KNVision = window.KNCore.page.startVisionClient(window);
