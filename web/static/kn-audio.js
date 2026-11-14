/**
 * The netplay engine's audio pipeline for this page (window.KNAudio): the
 * AudioContext, the AudioWorklet (or its ScriptProcessorNode fallback) and
 * the per-frame feed of the core's captured samples. The logic is
 * web/src/page/audio.ts; loaded after dist/kn-core.js and before the engine,
 * which reads window.KNAudio once when it loads.
 */
window.KNAudio = window.KNCore.page.startAudio(window);
