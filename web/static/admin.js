/**
 * admin.js — Admin Dashboard Controller
 *
 * Drives the admin.html management page: session log browser, client
 * event viewer, feedback list, screenshot timeline, and server stats.
 * Authenticates via ADMIN_KEY stored in sessionStorage.
 *
 * Consumed by: admin.html
 * Exposes: nothing (self-contained IIFE)
 */
(function () {
  'use strict';

  let adminKey = KNStorage.get('sessionStorage', 'kn-admin-key') || '';

  const $ = (sel) => document.querySelector(sel);

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      showToast('Clipboard unavailable');
      return false;
    }
  };

  // -- Auth ------------------------------------------------------------------

  const headers = () => (adminKey ? { 'X-Admin-Key': adminKey } : {});

  const checkAuth = async () => {
    try {
      const res = await fetch('/admin/api/stats', { headers: headers() });
      if (res.status === 401) {
        $('#auth-prompt').classList.remove('hidden');
        $('#admin-panel').classList.add('hidden');
        return false;
      }
      $('#auth-prompt').classList.add('hidden');
      $('#admin-panel').classList.remove('hidden');
      return true;
    } catch {
      return false;
    }
  };

  $('#auth-btn').addEventListener('click', async () => {
    adminKey = $('#admin-key-input').value.trim();
    KNStorage.set('sessionStorage', 'kn-admin-key', adminKey);
    const ok = await checkAuth();
    if (!ok) {
      $('#auth-error').classList.remove('hidden');
      KNStorage.remove('sessionStorage', 'kn-admin-key');
      adminKey = '';
    } else {
      $('#auth-error').classList.add('hidden');
      loadAll();
    }
  });

  $('#admin-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-btn').click();
  });

  // -- Tabs ------------------------------------------------------------------

  document.querySelectorAll('.tab-bar .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-bar .tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll('[id^="tab-"]').forEach((el) => {
        el.classList.toggle('hidden', el.id !== `tab-${target}`);
      });
    });
  });

  // -- Stats -----------------------------------------------------------------

  const formatBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const loadStats = async () => {
    const res = await fetch('/admin/api/stats', { headers: headers() });
    if (!res.ok) return;
    const s = await res.json();
    $('#stats-row').innerHTML = [
      { label: 'Active Rooms', value: `${escapeHtml(String(s.rooms))} / ${escapeHtml(String(s.max_rooms))}` },
      { label: 'Players', value: escapeHtml(String(s.players)) },
      { label: 'Spectators', value: escapeHtml(String(s.spectators)) },
      { label: 'Session Logs', value: escapeHtml(String(s.session_log_count ?? 0)) },
      { label: 'Client Events', value: escapeHtml(String(s.client_event_count ?? 0)) },
      { label: 'Feedback', value: escapeHtml(String(s.feedback_count ?? 0)) },
      { label: 'Retention', value: `${escapeHtml(String(s.retention_days))}d` },
    ]
      .map((c) => `<div class="stat-card"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`)
      .join('');
  };

  // -- Helpers ---------------------------------------------------------------

  const timeAgo = (ts) => {
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  const escapeHtml = (str) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const showToast = (msg) => {
    let toast = $('#toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  };

  // -- Session Logs ----------------------------------------------------------

  let currentSessionLogs = [];

  const loadSessionLogs = async () => {
    const res = await fetch('/admin/api/session-logs?days=30&limit=100', { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    currentSessionLogs = data.entries || [];
    renderSessionLogs();
  };

  const renderSessionLogs = () => {
    const container = $('#session-log-list');
    const noLogs = $('#no-session-logs');
    if (!currentSessionLogs.length) {
      container.innerHTML = '';
      noLogs.classList.remove('hidden');
      return;
    }
    noLogs.classList.add('hidden');

    // Group by match_id
    const groups = {};
    for (const log of currentSessionLogs) {
      const key = log.match_id || 'unknown';
      if (!groups[key]) groups[key] = { room: log.room, logs: [] };
      groups[key].logs.push(log);
    }

    container.innerHTML = Object.entries(groups)
      .map(([matchId, { room, logs }]) => {
        const rows = logs
          .map((l) => {
            const s = l.summary || {};
            const duration = s.duration_sec ? `${Math.floor(s.duration_sec / 60)}m${s.duration_sec % 60}s` : '-';
            const issues =
              [
                s.desyncs ? `${s.desyncs} desync${s.desyncs > 1 ? 's' : ''}` : '',
                s.stalls ? `${s.stalls} stall${s.stalls > 1 ? 's' : ''}` : '',
                s.reconnects ? `${s.reconnects} reconnect${s.reconnects > 1 ? 's' : ''}` : '',
              ]
                .filter(Boolean)
                .join(', ') || 'clean';
            const endedColor = { 'game-end': '#2ecc71', disconnect: '#e74c3c', leave: '#f39c12' }[l.ended_by] || '#888';
            return `<tr data-session-log-id="${escapeHtml(String(l.id))}">
            <td>P${escapeHtml(String(l.slot ?? '?'))}</td>
            <td>${escapeHtml(l.player_name || '-')}</td>
            <td>${duration}</td>
            <td>${issues}</td>
            <td><span style="color:${endedColor}">${escapeHtml(String(l.ended_by || 'active'))}</span></td>
            <td title="${escapeHtml(String(l.updated_at || ''))}">${l.updated_at ? timeAgo(new Date(l.updated_at + 'Z').getTime() / 1000) : '-'}</td>
          </tr>`;
          })
          .join('');

        return `<div class="room-group">
        <div class="room-header">
          <div class="room-info">
            <span class="room-code">${escapeHtml(room)}</span>
            <span class="room-meta">${logs.length} player${logs.length > 1 ? 's' : ''} &middot; ${escapeHtml(String(logs[0].mode || 'unknown'))}</span>
          </div>
        </div>
        <table>
          <thead><tr><th>Slot</th><th>Player</th><th>Duration</th><th>Issues</th><th>Ended</th><th>Updated</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
      })
      .join('');
  };

  const cleanupComparison = () => {
    if (_compState?.timer) clearInterval(_compState.timer);
    _compState = null;
    const old = document.getElementById('screenshot-section');
    if (old) old.remove();
  };

  const viewSessionLog = async (id) => {
    cleanupComparison();
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const title = $('#viewer-title');
    const meta = $('#viewer-meta');
    title.textContent = `Session Log #${id}`;
    meta.innerHTML = '';
    content.textContent = 'Loading...';
    viewer.classList.remove('hidden');

    const res = await fetch(`/admin/api/session-logs/${id}`, { headers: headers() });
    if (!res.ok) {
      content.textContent = 'Error loading log';
      return;
    }
    const data = await res.json();
    content.textContent = JSON.stringify(data, null, 2);

    // Load screenshots for this match
    if (data.match_id) {
      const ssRes = await fetch(`/admin/api/screenshots/${data.match_id}`, { headers: headers() });
      if (ssRes.ok) {
        const ssData = await ssRes.json();
        if (ssData.screenshots?.length) {
          // Group by slot
          const bySlot = {};
          for (const ss of ssData.screenshots) {
            (bySlot[ss.slot] ??= []).push(ss);
          }

          // Timeline thumbnail rows — all players share the same x-axis
          // so frames align vertically across slots
          const _bucket = (f) => Math.round(f / SCREENSHOT_BUCKET) * SCREENSHOT_BUCKET;

          // Build unified timeline of all bucket positions
          const allBuckets = new Set();
          const slotBucketMaps = {};
          for (const [slot, shots] of Object.entries(bySlot)) {
            const bm = new Map();
            for (const ss of shots) {
              const b = _bucket(ss.frame);
              bm.set(b, ss);
              allBuckets.add(b);
            }
            slotBucketMaps[slot] = bm;
          }
          const timeline = [...allBuckets].sort((a, b) => a - b);

          let html = '<div id="screenshot-section" style="margin-top:16px">';
          html += '<h3 style="color:#94a3b8;margin-bottom:8px">Screenshots</h3>';
          // Shared scrollable container so all rows scroll together
          html += '<div id="ss-timeline" style="overflow-x:auto;padding-bottom:8px">';
          for (const [slot] of Object.entries(bySlot).sort((a, b) => a[0] - b[0])) {
            const bm = slotBucketMaps[slot];
            html += `<div style="margin-bottom:8px"><div style="color:#64748b;font-size:12px;margin-bottom:4px">Player ${slot} (${bm.size} frames)</div>`;
            html += '<div style="display:flex;gap:4px">';
            for (const b of timeline) {
              const ss = bm.get(b);
              if (ss) {
                const url = `/admin/api/screenshots/img/${ss.id}?key=${encodeURIComponent(adminKey)}`;
                html += `<div style="flex-shrink:0;width:120px;text-align:center">`;
                html += `<img src="${url}" title="Frame ${ss.frame}" style="height:90px;border-radius:4px;cursor:pointer;border:1px solid #1e293b" onclick="window.open('${url}','_blank')">`;
                html += `<div style="font-size:9px;color:#475569;margin-top:2px">f${b}</div>`;
                html += `</div>`;
              } else {
                html += `<div style="flex-shrink:0;width:120px;text-align:center">`;
                html += `<div style="height:90px;border-radius:4px;border:1px dashed #1e293b"></div>`;
                html += `<div style="font-size:9px;color:#333;margin-top:2px">f${b}</div>`;
                html += `</div>`;
              }
            }
            html += '</div></div>';
          }
          html += '</div>';

          // Side-by-side comparison player (needs at least 2 slots)
          const slotKeys = Object.keys(bySlot).sort((a, b) => a - b);
          if (slotKeys.length >= 2) {
            html += buildComparisonPlayer(bySlot, slotKeys);
          }

          html += '</div>';
          content.insertAdjacentHTML('afterend', html);

          if (slotKeys.length >= 2) {
            initComparisonPlayer(bySlot, slotKeys);
          }
        }
      }
    }

    viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // -- Screenshot Comparison Player ------------------------------------------

  let _compState = null; // { frames, index, playing, timer, canvas, ctx, slotKeys, cols, rows }
  const SCREENSHOT_BUCKET = 300; // must match SCREENSHOT_INTERVAL in lockstep

  const buildComparisonPlayer = (bySlot, slotKeys) => {
    const W = 160,
      H = 120,
      GAP = 4,
      SCALE = 2;
    const cols = slotKeys.length <= 2 ? slotKeys.length : 2;
    const rows = Math.ceil(slotKeys.length / cols);
    const cw = W * cols + GAP * (cols - 1);
    const ch = H * rows + GAP * (rows - 1);
    const labels = slotKeys
      .map((s) => `<span style="color:#64748b;font-size:11px;flex:1;text-align:center">P${s}</span>`)
      .join('');
    // For 2x2, show top row labels above canvas, bottom row below
    const topLabels = slotKeys
      .slice(0, cols)
      .map((s) => `<span style="color:#64748b;font-size:11px;flex:1;text-align:center">P${s}</span>`)
      .join('');
    const bottomLabels =
      rows > 1
        ? slotKeys
            .slice(cols)
            .map((s) => `<span style="color:#64748b;font-size:11px;flex:1;text-align:center">P${s}</span>`)
            .join('')
        : '';
    return `
      <div style="margin-top:16px">
        <h4 style="color:#94a3b8;margin-bottom:8px">Player Comparison (${slotKeys.map((s) => 'P' + s).join(' / ')})</h4>
        <div style="background:#0a0a0a;border-radius:6px;padding:12px;display:inline-block">
          <div style="display:flex;gap:${GAP}px;margin-bottom:4px">${topLabels}</div>
          <canvas id="comp-canvas" width="${cw}" height="${ch}" style="width:${cw * SCALE}px;height:${ch * SCALE}px;border-radius:4px;image-rendering:pixelated;background:#000"></canvas>
          ${bottomLabels ? `<div style="display:flex;gap:${GAP}px;margin-top:4px">${bottomLabels}</div>` : ''}
          <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
            <button id="comp-prev" title="Previous frame" style="padding:4px 8px;cursor:pointer">&lt;</button>
            <button id="comp-play" title="Play/Pause" style="padding:4px 10px;cursor:pointer">Play</button>
            <button id="comp-next" title="Next frame" style="padding:4px 8px;cursor:pointer">&gt;</button>
            <input id="comp-scrub" type="range" min="0" max="0" value="0" style="flex:1;cursor:pointer">
            <span id="comp-frame-label" style="color:#64748b;font-size:11px;min-width:80px;text-align:right">f0 / 0</span>
          </div>
        </div>
      </div>`;
  };

  const initComparisonPlayer = (bySlot, slotKeys) => {
    const W = 160,
      H = 120,
      GAP = 4;
    const cols = slotKeys.length <= 2 ? slotKeys.length : 2;
    const rows = Math.ceil(slotKeys.length / cols);

    // Bucket screenshots by nearest SCREENSHOT_BUCKET to align frames across
    // players (frame numbers drift by +/-1 between peers in lockstep)
    const bucketMaps = {}; // slot -> Map(bucket -> screenshot)
    for (const slot of slotKeys) {
      const bm = new Map();
      for (const ss of bySlot[slot] || []) {
        const bucket = Math.round(ss.frame / SCREENSHOT_BUCKET) * SCREENSHOT_BUCKET;
        bm.set(bucket, ss);
      }
      bucketMaps[slot] = bm;
    }

    // Collect all unique buckets, sorted
    const allBuckets = new Set();
    for (const bm of Object.values(bucketMaps)) {
      for (const b of bm.keys()) allBuckets.add(b);
    }
    const sortedBuckets = [...allBuckets].sort((a, b) => a - b);

    // Build frame entries: one per bucket, with a screenshot per slot (or null)
    const frames = sortedBuckets.map((bucket) => {
      const slots = {};
      for (const slot of slotKeys) {
        slots[slot] = bucketMaps[slot].get(bucket) || null;
      }
      return { frame: bucket, slots };
    });

    if (!frames.length) return;

    const canvas = document.getElementById('comp-canvas');
    const ctx = canvas.getContext('2d');
    const scrub = document.getElementById('comp-scrub');
    const label = document.getElementById('comp-frame-label');
    const playBtn = document.getElementById('comp-play');
    const prevBtn = document.getElementById('comp-prev');
    const nextBtn = document.getElementById('comp-next');

    scrub.max = String(frames.length - 1);
    _compState = {
      frames,
      index: 0,
      playing: false,
      timer: null,
      canvas,
      ctx,
      slotKeys,
      cols,
      rows,
      imageCache: new Map(),
    };

    const drawFrame = (idx) => {
      if (idx < 0 || idx >= frames.length) return;
      _compState.index = idx;
      scrub.value = String(idx);
      const entry = frames[idx];
      label.textContent = `f${entry.frame} (${idx + 1}/${frames.length})`;

      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Grid separators
      ctx.fillStyle = '#333';
      for (let c = 1; c < cols; c++) ctx.fillRect(c * W + (c - 1) * GAP, 0, GAP, canvas.height);
      for (let r = 1; r < rows; r++) ctx.fillRect(0, r * H + (r - 1) * GAP, canvas.width, GAP);

      const drawCell = (ss, col, row) => {
        if (!ss) return;
        const x = col * (W + GAP);
        const y = row * (H + GAP);
        const key = ss.id;
        if (_compState.imageCache.has(key)) {
          ctx.drawImage(_compState.imageCache.get(key), x, y, W, H);
          return;
        }
        const img = new Image();
        img.onload = () => {
          _compState.imageCache.set(key, img);
          if (_compState.index === idx) ctx.drawImage(img, x, y, W, H);
        };
        img.src = `/admin/api/screenshots/img/${ss.id}?key=${encodeURIComponent(adminKey)}`;
      };

      slotKeys.forEach((slot, i) => {
        drawCell(entry.slots[slot], i % cols, Math.floor(i / cols));
      });

      // Preload next 3 frames
      for (let i = idx + 1; i < Math.min(idx + 4, frames.length); i++) {
        for (const slot of slotKeys) {
          const ss = frames[i].slots[slot];
          if (ss && !_compState.imageCache.has(ss.id)) {
            const pre = new Image();
            pre.onload = () => _compState.imageCache.set(ss.id, pre);
            pre.src = `/admin/api/screenshots/img/${ss.id}?key=${encodeURIComponent(adminKey)}`;
          }
        }
      }
    };

    const step = (delta) => {
      const next = _compState.index + delta;
      if (next >= 0 && next < frames.length) drawFrame(next);
      else if (_compState.playing) {
        _compState.playing = false;
        clearInterval(_compState.timer);
        _compState.timer = null;
        playBtn.textContent = 'Play';
      }
    };

    playBtn.addEventListener('click', () => {
      if (_compState.playing) {
        _compState.playing = false;
        clearInterval(_compState.timer);
        _compState.timer = null;
        playBtn.textContent = 'Play';
      } else {
        if (_compState.index >= frames.length - 1) _compState.index = -1;
        _compState.playing = true;
        playBtn.textContent = 'Pause';
        _compState.timer = setInterval(() => step(1), 200);
      }
    });
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    scrub.addEventListener('input', () => drawFrame(parseInt(scrub.value, 10)));

    drawFrame(0);
  };

  // -- Client Events ---------------------------------------------------------

  const _typeColors = {
    'webrtc-fail': '#e74c3c',
    'wasm-fail': '#e74c3c',
    desync: '#f39c12',
    stall: '#f39c12',
    reconnect: '#3498db',
    'audio-fail': '#e67e22',
    unhandled: '#e74c3c',
    compat: '#9b59b6',
    'session-end': '#2ecc71',
  };

  let currentClientEvents = [];

  const loadClientEvents = async () => {
    const filterType = $('#error-type-filter')?.value || '';
    const params = new URLSearchParams({ days: '30', limit: '100' });
    if (filterType) params.set('type', filterType);
    const res = await fetch(`/admin/api/client-events?${params}`, { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    currentClientEvents = data.entries || [];
    renderClientEvents();
  };

  const renderClientEvents = () => {
    const container = $('#error-list');
    const noErrors = $('#no-errors');
    if (!currentClientEvents.length) {
      container.innerHTML = '';
      noErrors.classList.remove('hidden');
      return;
    }
    noErrors.classList.add('hidden');

    container.innerHTML = currentClientEvents
      .map((e) => {
        const color = _typeColors[e.type] || '#999';
        return `<div class="feedback-card" data-event-id="${escapeHtml(String(e.id))}">
        <div class="feedback-header">
          <span class="source-badge" style="border-color:${color};color:${color}">${escapeHtml(e.type)}</span>
          <span class="feedback-date">${e.created_at ? timeAgo(new Date(e.created_at + 'Z').getTime() / 1000) : ''}</span>
        </div>
        <div class="feedback-message">${escapeHtml(e.message || '')}</div>
        ${e.room ? `<div class="feedback-meta">Room: ${escapeHtml(e.room)}</div>` : ''}
      </div>`;
      })
      .join('');
  };

  if ($('#error-type-filter')) {
    $('#error-type-filter').addEventListener('change', loadClientEvents);
  }

  // -- Feedback --------------------------------------------------------------

  let currentFeedback = [];

  const _categoryColors = {
    bug: '#e74c3c',
    feature: '#3498db',
    general: '#2ecc71',
  };

  const _categoryEmoji = {
    bug: '\u{1F41B}',
    feature: '\u{1F4A1}',
    general: '\u{1F4AC}',
  };

  const formatUserAgent = (ua) => {
    if (!ua) return '';
    if (ua.includes('iPhone')) return 'iPhone ' + (ua.match(/Version\/([\d.]+)/)?.[1] || 'Safari');
    if (ua.includes('iPad')) return 'iPad ' + (ua.match(/Version\/([\d.]+)/)?.[1] || 'Safari');
    if (ua.includes('Android')) return 'Android ' + (ua.match(/Chrome\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Chrome')) return 'Chrome ' + (ua.match(/Chrome\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Firefox')) return 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '');
    if (ua.includes('Safari')) return 'Safari ' + (ua.match(/Version\/([\d.]+)/)?.[1] || '');
    return ua.substring(0, 40);
  };

  const loadFeedback = async () => {
    const category = $('#feedback-category-filter')?.value || '';
    const params = new URLSearchParams({ days: '90', limit: '100' });
    if (category) params.set('category', category);
    const res = await fetch(`/admin/api/feedback?${params}`, { headers: headers() });
    if (!res.ok) return;
    const data = await res.json();
    currentFeedback = data.entries || [];
    renderFeedback();
  };

  const renderFeedback = () => {
    const container = $('#feedback-list');
    const noFeedback = $('#no-feedback');

    if (currentFeedback.length === 0) {
      container.innerHTML = '';
      noFeedback.classList.remove('hidden');
      return;
    }
    noFeedback.classList.add('hidden');

    container.innerHTML = currentFeedback
      .map((fb) => {
        const color = _categoryColors[fb.category] || '#999';
        const emoji = _categoryEmoji[fb.category] || '';
        const ctx = fb.context || {};
        const metaParts = [];
        if (ctx.playerName) metaParts.push(escapeHtml(ctx.playerName));
        if (ctx.page) metaParts.push(escapeHtml(ctx.page));
        if (ctx.roomCode) metaParts.push(`Room: ${escapeHtml(ctx.roomCode)}`);
        if (ctx.mode) metaParts.push(escapeHtml(ctx.mode));
        if (ctx.peerCount != null)
          metaParts.push(`${escapeHtml(String(ctx.peerCount))} peer${ctx.peerCount !== 1 ? 's' : ''}`);
        if (ctx.userAgent) metaParts.push(escapeHtml(formatUserAgent(ctx.userAgent)));

        const sessionStats = ctx.sessionStats;
        const statsParts = [];
        if (sessionStats) {
          if (sessionStats.desyncs)
            statsParts.push(`${escapeHtml(String(sessionStats.desyncs))} desync${sessionStats.desyncs > 1 ? 's' : ''}`);
          if (sessionStats.stalls)
            statsParts.push(`${escapeHtml(String(sessionStats.stalls))} stall${sessionStats.stalls > 1 ? 's' : ''}`);
          if (sessionStats.reconnects)
            statsParts.push(
              `${escapeHtml(String(sessionStats.reconnects))} reconnect${sessionStats.reconnects > 1 ? 's' : ''}`,
            );
        }

        const created = fb.created_at ? new Date(fb.created_at + 'Z').toLocaleString() : '';

        return `<div class="feedback-card" data-feedback-id="${escapeHtml(String(fb.id))}">
          <div class="feedback-header">
            <span class="source-badge" style="border-color:${color};color:${color}">${emoji} ${escapeHtml(fb.category)}</span>
            <span class="feedback-date" title="${escapeHtml(created)}">${created ? timeAgo(new Date(fb.created_at + 'Z').getTime() / 1000) : ''}</span>
          </div>
          <div class="feedback-message">${escapeHtml(fb.message)}</div>
          ${fb.email ? `<div class="feedback-email">${escapeHtml(fb.email)}</div>` : ''}
          ${metaParts.length ? `<div class="feedback-meta">${metaParts.join(' &middot; ')}</div>` : ''}
          ${statsParts.length ? `<div class="feedback-stats">${statsParts.join(' &middot; ')}</div>` : ''}
        </div>`;
      })
      .join('');
  };

  if ($('#feedback-category-filter')) {
    $('#feedback-category-filter').addEventListener('change', loadFeedback);
  }

  $('#feedback-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('.feedback-card');
    if (!card) return;
    const id = card.dataset.feedbackId;
    const fb = currentFeedback.find((f) => String(f.id) === id);
    if (!fb) return;
    // Show full feedback in the viewer
    const viewer = $('#log-viewer');
    $('#viewer-title').textContent = `Feedback #${fb.id} — ${fb.category}`;
    $('#viewer-meta').innerHTML = fb.email ? `<span class="meta-tag">${escapeHtml(fb.email)}</span>` : '';
    $('#viewer-content').textContent = JSON.stringify(fb, null, 2);
    viewer.classList.remove('hidden');
    viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // -- Viewer ----------------------------------------------------------------

  $('#viewer-close').addEventListener('click', () => {
    cleanupComparison();
    $('#log-viewer').classList.add('hidden');
  });

  $('#viewer-copy').addEventListener('click', async () => {
    const content = $('#viewer-content').textContent;
    if (content && (await copyText(content))) {
      showToast('Log copied');
    }
  });

  // -- Init ------------------------------------------------------------------

  const loadAll = async () => {
    await loadStats();
    await loadSessionLogs();
    await loadClientEvents();
    await loadFeedback();
  };

  const init = async () => {
    const ok = await checkAuth();
    if (ok) loadAll();
  };

  // -- Event delegation ------------------------------------------------------

  $('#session-log-list')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-session-log-id]');
    if (row) viewSessionLog(row.dataset.sessionLogId);
  });

  $('#error-list')?.addEventListener('click', (e) => {
    const card = e.target.closest('[data-event-id]');
    if (!card) return;
    const id = card.dataset.eventId;
    const evt = currentClientEvents.find((ev) => String(ev.id) === id);
    if (!evt) return;
    $('#log-viewer').classList.remove('hidden');
    $('#viewer-title').textContent = `Event #${id} — ${evt.type}`;
    $('#viewer-meta').innerHTML = '';
    $('#viewer-content').textContent = JSON.stringify(evt, null, 2);
    $('#log-viewer').scrollIntoView({ behavior: 'smooth' });
  });

  $('#refresh-btn').addEventListener('click', () => loadAll());

  init();
})();
