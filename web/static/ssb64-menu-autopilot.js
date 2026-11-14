/**
 * Closed-loop menu driver for the rollback demo and the two-player test
 * (window.KNMenuAutopilot = { create, isSsb64UsRom, SCENE, BTN,
 * PORTRAIT_TARGETS, MAPS_TARGET_SLOT }). The logic is
 * web/src/page/menu-autopilot.ts; loaded after dist/kn-core.js, on the demo
 * page by its HTML and on the play page by tests/rb-two-player.mjs.
 */
window.KNMenuAutopilot = window.KNCore.page.menuAutopilot;
