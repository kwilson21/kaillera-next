/**
 * The N64 touch controls for phone and tablet players (window.VirtualGamepad:
 * init, destroy, setVisible). The logic is web/src/page/virtual-gamepad/;
 * loaded after dist/kn-core.js and kn-state.js, and before the engines.
 * Nothing is built until play.js or an engine calls init.
 */
window.VirtualGamepad = window.KNCore.page.startVirtualGamepad(window);
