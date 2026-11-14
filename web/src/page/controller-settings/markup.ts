/**
 * The controller settings panel's stylesheet and the two stick drawings,
 * character for character as web/static/controller-settings.js had them.
 */

/** The panel's own styles; it adds them to the page so it works on any page that loads it. */
export const PANEL_CSS = `
#controller-settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.95);width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);background:#0f1923;border:1px solid #1e293b;border-radius:12px;z-index:102;overflow-y:auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;opacity:0;pointer-events:none;transition:transform .2s ease,opacity .2s ease}
#controller-settings.open{transform:translate(-50%,-50%) scale(1);opacity:1;pointer-events:auto}
#controller-settings .cs-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
#controller-settings .cs-title{font-size:15px;font-weight:600;color:#f1f5f9}
#controller-settings .cs-close{background:none;border:none;color:#475569;font-size:18px;cursor:pointer;padding:4px 8px}
#controller-settings .cs-close:hover{color:#94a3b8}
#controller-settings .cs-section-label{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
#controller-settings .cs-sep{border-top:1px solid #1e293b;margin:14px 0}
#controller-settings .cs-map-grid{background:#0a1019;border-radius:6px;padding:10px;display:grid;grid-template-columns:60px 1fr 1fr;gap:4px 8px;align-items:center}
#controller-settings .cs-map-label{font-size:11px;color:#94a3b8}
#controller-settings .cs-map-bind{background:#1e293b;border:1px solid #334155;border-radius:3px;padding:3px 8px;font-size:10px;color:#cbd5e1;text-align:center;cursor:pointer;min-height:24px;display:flex;align-items:center;justify-content:center}
#controller-settings .cs-map-bind:hover{border-color:#475569}
#controller-settings .cs-map-bind.listening{border-color:#3b82f6;color:#3b82f6;animation:cs-pulse 1s infinite}
#controller-settings .cs-map-bind.axis-bind{color:#eab308}
#controller-settings .cs-map-bind.disabled{color:#334155;cursor:default;border-color:#1e293b}
@keyframes cs-pulse{0%,100%{opacity:1}50%{opacity:.5}}
#controller-settings .cs-map-group{grid-column:1/-1;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-top:4px;padding-top:6px;border-top:1px solid #1e293b}
#controller-settings .cs-map-header-row{grid-column:1/-1;display:grid;grid-template-columns:60px 1fr 1fr;gap:8px;margin-bottom:4px}
#controller-settings .cs-map-col-label{font-size:9px;color:#475569;text-transform:uppercase;text-align:center}
#controller-settings .cs-quick-btn{background:#1d4ed8;color:#fff;font-size:10px;font-weight:600;padding:4px 10px;border-radius:4px;border:none;cursor:pointer}
#controller-settings .cs-quick-btn:hover{background:#2563eb}
#controller-settings .cs-viz-wrap{background:#0a1019;border-radius:8px;padding:16px;margin-bottom:16px}
#controller-settings .cs-viz-row{display:flex;gap:20px;justify-content:center;align-items:flex-start}
#controller-settings .cs-viz-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:8px;text-align:center}
#controller-settings .cs-viz-coords{font-size:10px;color:#475569;margin-top:6px;font-family:monospace;text-align:center}
#controller-settings .cs-no-gamepad{font-size:10px;color:#475569;text-align:center;margin-top:8px}
#controller-settings .cs-slider-row{margin-bottom:12px}
#controller-settings .cs-slider-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}
#controller-settings .cs-slider-name{font-size:12px;color:#cbd5e1}
#controller-settings .cs-slider-val{font-size:12px;font-weight:600;font-family:monospace}
#controller-settings input[type='range']{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:3px;background:#1e293b;outline:none}
#controller-settings input[type='range']::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#f1f5f9;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4)}
#controller-settings .cs-slider-hint{font-size:9px;color:#475569;margin-top:2px}
#controller-settings .cs-dz-card{background:#0a1019;border-radius:6px;padding:10px 12px;margin-bottom:8px}
#controller-settings .cs-dz-title{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:8px}
#controller-settings .cs-dz-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
#controller-settings .cs-dz-row:last-child{margin-bottom:0}
#controller-settings .cs-dz-axis{font-size:11px;color:#64748b;width:14px}
#controller-settings .cs-dz-val{font-size:11px;color:#ef4444;font-family:monospace;width:32px;text-align:right}
#controller-settings .cs-footer{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #1e293b;margin-top:14px}
#controller-settings .cs-footer label{display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer}
#controller-settings .cs-footer-reset{font-size:11px;color:#475569;background:none;border:none;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
#cs-backdrop{position:fixed;top:0;left:0;width:100%;height:100%;z-index:101;background:rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s ease}
#cs-backdrop.visible{opacity:1;pointer-events:auto}
@media(max-width:480px){#controller-settings{width:calc(100vw - 16px);max-height:calc(100vh - 16px)}}
  `;

/** The left stick: outer ring, range ring, dead-zone ring, crosshair, two trail dots and the dot. */
export const LEFT_STICK_SVG = `
      <circle cx="60" cy="60" r="56" fill="none" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="60" cy="60" r="37" fill="none" stroke="#334155" stroke-width="1" stroke-dasharray="3,3" class="cs-range-ring"/>
      <circle cx="60" cy="60" r="8" fill="rgba(239,68,68,0.08)" stroke="#ef4444" stroke-width="1" stroke-opacity="0.4" class="cs-dz-ring"/>
      <line x1="60" y1="8" x2="60" y2="112" stroke="#1e293b" stroke-width="0.5"/>
      <line x1="8" y1="60" x2="112" y2="60" stroke="#1e293b" stroke-width="0.5"/>
      <circle cx="60" cy="60" r="2.5" fill="#3b82f6" opacity="0.2" class="cs-trail-2"/>
      <circle cx="60" cy="60" r="3" fill="#3b82f6" opacity="0.4" class="cs-trail-1"/>
      <circle cx="60" cy="60" r="5" fill="#3b82f6" class="cs-dot"/>
    `;

/** The C stick: outer ring, guide ring, dead-zone ring, crosshair and the dot. */
export const C_STICK_SVG = `
      <circle cx="40" cy="40" r="36" fill="none" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="40" cy="40" r="24" fill="none" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>
      <circle cx="40" cy="40" r="5" fill="rgba(239,68,68,0.08)" stroke="#ef4444" stroke-width="1" stroke-opacity="0.4" class="cs-dz-ring"/>
      <line x1="40" y1="6" x2="40" y2="74" stroke="#1e293b" stroke-width="0.5"/>
      <line x1="6" y1="40" x2="74" y2="40" stroke="#1e293b" stroke-width="0.5"/>
      <circle cx="40" cy="40" r="4" fill="#64748b" class="cs-dot"/>
    `;
