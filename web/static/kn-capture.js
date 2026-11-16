/**
 * Diagnostic gameplay-canvas capture policy for this page (window.KNCapture).
 * The logic is web/src/page/capture.ts; loaded before every script that takes
 * pictures, and after dist/kn-core.js.
 */
window.KNCapture = window.KNCore.page.startCapture(window);
