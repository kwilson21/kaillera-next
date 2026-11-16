/**
 * The in-game controller settings panel (window.ControllerSettings): button
 * and key mapping, live stick preview, range, sensitivity and dead zones.
 * The logic is web/src/page/controller-settings/; loaded after
 * dist/kn-core.js, and before the page script that opens the panel.
 */
window.ControllerSettings = window.KNCore.page.startControllerSettings(window);
