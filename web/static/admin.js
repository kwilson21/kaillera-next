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
      // Close the log viewer modal when switching tabs — it's a sibling of
      // the tab containers, so it would otherwise linger from a previous tab.
      const viewer = document.getElementById('log-viewer');
      if (viewer && !viewer.classList.contains('hidden')) {
        resetViewer();
        viewer.classList.add('hidden');
      }
    });
  });

  // -- Stats -----------------------------------------------------------------

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
    const q = ($('#session-search')?.value || '').trim();
    const params = new URLSearchParams({ days: '30', limit: '100' });
    if (q) {
      // Unified server-side search across room, player_name, and match_id.
      // Server uses LIKE so partial matches work — searching "kaz" finds
      // "kazon", "Kazon Wilson", "KAZ123" room codes, etc. No client-side
      // classification — let the server search all three fields.
      params.set('q', q);
    }
    const res = await fetch(`/admin/api/session-logs?${params}`, { headers: headers() });
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
                .join(', ') || 'No issues recorded';
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

        const auditLink =
          matchId && matchId !== 'unknown'
            ? `<a href="#" class="input-audit-link" data-match-id="${escapeHtml(matchId)}" title="View raw input audit JSON">input audit</a>`
            : '';
        return `<div class="room-group">
        <div class="room-header">
          <div class="room-info">
            <span class="room-code">${escapeHtml(room)}</span>
            <span class="room-meta">${logs.length} player${logs.length > 1 ? 's' : ''} &middot; ${escapeHtml(String(logs[0].mode || 'unknown'))}${auditLink ? ' &middot; ' + auditLink : ''}</span>
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

  let sessionView = null;
  let auditRequest = null;

  const clearCaptureFrame = (view) => {
    view.capture?.controller.abort();
    view.capture = null;
  };

  const resetViewer = () => {
    auditRequest?.abort();
    auditRequest = null;
    if (sessionView) {
      sessionView.controller.abort();
      clearCaptureFrame(sessionView);
      sessionView = null;
    }
    $('#viewer-extras').innerHTML = '';
    $('#captures-content').replaceChildren();
    $('#viewer-captures').classList.add('hidden');
    $('#viewer-download').classList.add('hidden');
    $('#viewer-copy').textContent = 'Copy';
  };

  const fetchAdmin = async (path, signal) => {
    const res = await fetch(path, { headers: headers(), signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  };

  const viewSessionLog = async (id) => {
    resetViewer();
    const view = { id, controller: new AbortController(), data: null, events: [], verdicts: [], capture: null };
    sessionView = view;
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const signal = view.controller.signal;
    $('#viewer-title').textContent = `Session Log #${id}`;
    $('#viewer-meta').textContent = '';
    content.textContent = 'Loading summary…';
    viewer.classList.remove('hidden');
    viewer.scrollIntoView({ block: 'start' });

    try {
      const res = await fetchAdmin(`/admin/api/session-logs/${encodeURIComponent(id)}/summary`, signal);
      const data = await res.json();
      if (sessionView !== view) return;
      view.data = data;
      $('#viewer-meta').textContent = [data.room, data.player_name, data.mode].filter(Boolean).join(' · ');
      content.textContent = JSON.stringify(data, null, 2);
      $('#viewer-copy').textContent = 'Copy summary';
      const download = $('#viewer-download');
      download.disabled = false;
      download.classList.remove('hidden');
      if (data.match_id) {
        $('#viewer-captures').classList.remove('hidden');
        $('#captures-show').textContent = 'Compare screenshots';
        $('#captures-show').classList.remove('hidden');
        $('#capture-controls').classList.add('hidden');
        $('#captures-verdict').textContent = '';
        $('#captures-status').textContent = '';
        $('#capture-seek').value = '';
      }

      const extras = $('#viewer-extras');
      if (!data.match_id && !data.room) return;
      const timeline = document.createElement('div');
      timeline.textContent = 'Loading timeline…';
      const verdicts = document.createElement('div');
      if (data.match_id) verdicts.textContent = 'Desync not verified.';
      extras.append(verdicts, timeline);
      // These are independent: a timeline failure cannot block verdicts,
      // raw download, screenshots or the summary already on screen.
      void fetchSessionTimeline(data.match_id, data.room, signal)
        .then((tl) => {
          if (sessionView !== view) return;
          if (tl._error) throw new Error(tl._error);
          view.events = tl.events || [];
          if (!view.events.length) timeline.textContent = 'No timeline events recorded.';
          else
            timeline.innerHTML =
              renderHorizontalTimeline(view.events) +
              renderSessionHeader(view.events) +
              renderEventTimeline(view.events);
        })
        .catch(() => {
          if (sessionView === view) timeline.textContent = 'Could not load the session timeline.';
        });
      if (data.match_id) {
        void fetchAdmin(`/admin/api/desync-events?compact=true&match_id=${encodeURIComponent(data.match_id)}`, signal)
          .then((result) => result.json())
          .then((body) => {
            if (sessionView !== view) return;
            if (body.match_id !== data.match_id) throw new Error('Verdicts returned for another match');
            view.verdicts = (body.events || []).filter(hasVisionCaptureEvidence);
            paintCaptureVerdict(view);
          })
          .catch(() => {
            if (sessionView === view) verdicts.textContent = 'Could not load vision verdicts.';
          });
      }
    } catch {
      if (sessionView === view) content.textContent = 'Could not load the session summary.';
    }
  };

  // -- Screenshot Comparison -------------------------------------------------

  const hasVisionCaptureEvidence = (event) =>
    typeof event.vision_equal === 'boolean' &&
    Number.isSafeInteger(event.captured_frame) &&
    Number.isSafeInteger(event.frame) &&
    event.captured_frame >= event.frame &&
    Array.isArray(event.capture_slots) &&
    event.capture_slots.length === 2 &&
    event.capture_slots[0] !== event.capture_slots[1] &&
    event.capture_slots.every((slot) => Number.isInteger(slot) && slot >= 0 && slot < 4);

  const paintCaptureVerdict = (view) => {
    const frame = view.capture?.frame;
    const rows = view.verdicts.filter(
      (event) => event.captured_frame === frame && event.capture_slots.every((slot) => view.capture.slots?.has(slot)),
    );
    let label = '';
    // The model saw different uploads; do not present its result as a
    // verification of the archived files on screen or of the whole match.
    if (rows.some((event) => event.vision_equal === false))
      label = `A separate vision comparison flagged a mismatch in captures tagged frame ${frame}.`;
    else if (rows.some((event) => event.vision_equal === true))
      label = `A separate vision comparison found no mismatch in captures tagged frame ${frame}.`;
    $('#captures-verdict').textContent = label;
  };

  const imageDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      // The strict admin CSP allows data images, not blob images. Normalize
      // to JPEG instead of trusting a content type or widening the CSP.
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([blob], { type: 'image/jpeg' }));
    });

  const loadCaptureImage = async (view, capture, shot, body, slot) => {
    const current = () => sessionView === view && view.capture === capture;
    try {
      const res = await fetch(`/admin/api/screenshots/img/${encodeURIComponent(shot.id)}`, {
        headers: headers(),
        signal: capture.controller.signal,
      });
      if (!current()) return;
      if (res.status === 404) {
        body.textContent = 'Stored screenshot is missing.';
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const src = await imageDataUrl(await res.blob());
      if (!current()) return;
      const image = document.createElement('img');
      image.alt = `Player ${slot} at frame ${capture.frame}`;
      image.onload = () => {
        if (current()) body.replaceChildren(image);
      };
      image.onerror = () => {
        if (current()) body.textContent = 'Could not decode the screenshot.';
      };
      image.src = src;
    } catch {
      if (current()) body.textContent = 'Could not load the screenshot.';
    }
  };

  const loadCaptureFrame = async (view, frame) => {
    if (sessionView !== view || !view.data?.match_id) return;
    clearCaptureFrame(view);
    const capture = { controller: new AbortController(), requested: frame };
    view.capture = capture;
    const status = $('#captures-status');
    const host = $('#captures-content');
    const show = $('#captures-show');
    const prev = $('#captures-prev');
    const next = $('#captures-next');
    host.replaceChildren();
    show.classList.add('hidden');
    $('#capture-controls').classList.remove('hidden');
    prev.disabled = true;
    next.disabled = true;
    $('#captures-verdict').textContent = '';
    status.textContent = 'Loading screenshots…';
    try {
      const params = frame == null ? '' : `?frame=${frame}`;
      const res = await fetchAdmin(
        `/admin/api/screenshots/${encodeURIComponent(view.data.match_id)}/frame${params}`,
        capture.controller.signal,
      );
      const data = await res.json();
      if (sessionView !== view || view.capture !== capture) return;
      capture.frame = data.frame;
      capture.previous = data.previous_frame;
      capture.next = data.next_frame;
      prev.disabled = capture.previous == null;
      next.disabled = capture.next == null;
      $('#capture-seek').value = capture.frame == null ? '' : String(capture.frame);
      capture.slots = new Set(data.screenshots.filter((shot) => shot.frame === capture.frame).map((shot) => shot.slot));
      paintCaptureVerdict(view);
      if (!data.slots.length) {
        status.textContent = 'No screenshots recorded for this match.';
        return;
      }
      const bySlot = new Map(data.screenshots.map((shot) => [shot.slot, shot]));
      status.textContent = bySlot.size
        ? `Frame ${capture.frame} · ${bySlot.size} of ${data.slots.length} captured players`
        : `No exact screenshots at frame ${capture.frame}. Use Previous or Next to see captured frames.`;
      if (!bySlot.size) return;
      for (const slot of data.slots) {
        const panel = document.createElement('div');
        panel.className = 'capture-player';
        const label = document.createElement('h5');
        label.textContent = `Player ${slot}`;
        const body = document.createElement('div');
        const shot = bySlot.get(slot);
        body.textContent = shot ? 'Loading image…' : 'No exact capture at this frame.';
        panel.append(label, body);
        host.append(panel);
        if (shot) void loadCaptureImage(view, capture, shot, body, slot);
      }
    } catch {
      if (sessionView !== view || view.capture !== capture) return;
      status.textContent = 'Could not load screenshot metadata.';
      show.textContent = 'Retry screenshots';
      show.classList.remove('hidden');
    }
  };

  $('#captures-seek').addEventListener('submit', (event) => {
    event.preventDefault();
    const frame = Number($('#capture-seek').value);
    if (sessionView && Number.isSafeInteger(frame) && frame >= 0) void loadCaptureFrame(sessionView, frame);
  });

  $('#captures-show').addEventListener('click', () => {
    if (sessionView) void loadCaptureFrame(sessionView, sessionView.capture?.requested);
  });
  $('#captures-prev').addEventListener('click', () => {
    if (sessionView?.capture?.previous != null) void loadCaptureFrame(sessionView, sessionView.capture.previous);
  });
  $('#captures-next').addEventListener('click', () => {
    if (sessionView?.capture?.next != null) void loadCaptureFrame(sessionView, sessionView.capture.next);
  });

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
        if (ctx.roomCode)
          metaParts.push(
            `Room: <a href="#" class="feedback-session-link" data-session-search="${escapeHtml(ctx.roomCode)}">${escapeHtml(ctx.roomCode)}</a>`,
          );
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
    // Room-code link → jump to Session Logs tab and search for this room
    const sessionLink = e.target.closest('.feedback-session-link');
    if (sessionLink) {
      e.preventDefault();
      e.stopPropagation();
      const query = sessionLink.dataset.sessionSearch || '';
      document.querySelector('.tab-bar .tab[data-tab="logs"]')?.click();
      const searchInput = $('#session-search');
      if (searchInput) {
        searchInput.value = query;
        loadSessionLogs();
      }
      return;
    }
    const card = e.target.closest('.feedback-card');
    if (!card) return;
    const id = card.dataset.feedbackId;
    const fb = currentFeedback.find((f) => String(f.id) === id);
    if (!fb) return;
    // Show full feedback in the viewer
    resetViewer();
    const viewer = $('#log-viewer');
    $('#viewer-title').textContent = `Feedback #${fb.id} — ${fb.category}`;
    $('#viewer-meta').innerHTML = fb.email ? `<span class="meta-tag">${escapeHtml(fb.email)}</span>` : '';
    $('#viewer-extras').innerHTML = '';
    $('#viewer-content').textContent = JSON.stringify(fb, null, 2);
    viewer.classList.remove('hidden');
    viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // Session Logs search — debounced reload on input
  {
    let _searchDebounce = null;
    $('#session-search')?.addEventListener('input', () => {
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(loadSessionLogs, 250);
    });
  }

  // Horizontal timeline → vertical row jump. Clicking an event marker on the
  // overview bar scrolls the matching row in the vertical timeline into view
  // and briefly flashes it. Scrolling is done manually on the inner
  // `#tl-scroll-container` so the outer page doesn't move — the horizontal
  // overview stays pinned in view while the detail list scrolls independently.
  $('#viewer-extras')?.addEventListener('click', (e) => {
    const marker = e.target.closest('.tl-marker');
    if (!marker) return;
    const ts = marker.dataset.ts;
    if (!ts) return;
    const row = document.querySelector(`.tl-row[data-ts="${ts}"]`);
    if (!row) return;
    const container = document.getElementById('tl-scroll-container');
    if (container) {
      // Compute scroll position manually so only the inner container scrolls
      const targetScrollTop = row.offsetTop - container.clientHeight / 2 + row.offsetHeight / 2;
      container.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    }
    // Brief flash highlight so the operator sees where the click landed
    const originalOutline = row.style.outline;
    row.style.outline = '2px solid #f5c542';
    row.style.transition = 'outline 0.3s';
    setTimeout(() => {
      row.style.outline = originalOutline;
    }, 1200);
  });

  // -- Session timeline (P0-1 reliability telemetry) ------------------------
  // Primary view: a single chronological timeline of every signal about the
  // session. Everything with a timestamp (events now; screenshots, input
  // audit, feedback, sync log in future iterations) hangs off the same
  // timeline. See memory/project_session_timeline_vision.md.

  // Event type categories — used for colorization only, not for structural
  // decisions. The timeline is the source of truth; these are presentation.
  const STAGE_EVENTS = new Set([
    'room_created',
    'peer_joined',
    'webrtc_connected',
    'rom_loaded',
    'emulator_booted',
    'first_frame_rendered',
    'milestone_reached',
  ]);
  const LIFECYCLE_EVENTS = new Set(['peer_left', 'peer_reconnected']);
  const ERROR_TYPES = new Set([
    'webrtc-fail',
    'wasm-fail',
    'stall',
    'desync',
    'audio-fail',
    'unhandled',
    'compat',
    'reconnect',
  ]);

  // Smart relative-timestamp formatter. Keeps the display readable across
  // sessions whose durations vary from milliseconds to minutes.
  const formatRelTime = (ms) => {
    if (ms == null || !Number.isFinite(ms)) return '';
    if (ms < 1000) return `+${ms}ms`;
    if (ms < 60000) return `+${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return secs === 0 ? `+${mins}m` : `+${mins}m ${secs}s`;
  };

  // Slot colorization — stable per-slot color for the slot badge and row tint.
  const SLOT_COLORS = ['#4a9eff', '#2ecc71', '#f39c12', '#e74c3c'];
  const SLOT_ROW_TINTS = ['#10233a', '#0f2a1a', '#2a200f', '#2a0f15'];
  const slotColor = (slot) => (slot != null && slot >= 0 && slot < SLOT_COLORS.length ? SLOT_COLORS[slot] : '#888');
  const slotRowTint = (slot) =>
    slot != null && slot >= 0 && slot < SLOT_ROW_TINTS.length ? SLOT_ROW_TINTS[slot] : 'transparent';

  // Determine the participant slot a given event should be attributed to.
  // Most events use `slot` directly. Lifecycle events are emitted by the host
  // but logically belong to the peer that left/reconnected, so we pull
  // `meta.peer_slot` for those.
  const attributedSlot = (ev) => {
    if (LIFECYCLE_EVENTS.has(ev.type)) {
      return ev.meta?.peer_slot ?? null;
    }
    return ev.slot != null && ev.slot !== -1 ? ev.slot : null;
  };

  const fetchSessionTimeline = async (matchId, room, signal) => {
    const params = new URLSearchParams();
    if (matchId) params.set('match_id', matchId);
    if (room) params.set('room', room);
    const res = await fetch(`/admin/api/session-timeline?${params}`, { headers: headers(), signal });
    if (!res.ok) {
      return { _error: `HTTP ${res.status}: ${res.statusText || 'request failed'}` };
    }
    return res.json();
  };

  // Session header — a one-line summary computed from the raw timeline events.
  // Shows room, match, duration, participants, error counts. Pure function
  // of the event list; no state machine, no per-stage rules.
  const renderSessionHeader = (events) => {
    if (!events.length) return '';
    const sorted = [...events].sort(
      (a, b) => new Date(a.created_at + 'Z').getTime() - new Date(b.created_at + 'Z').getTime(),
    );
    const firstTs = new Date(sorted[0].created_at + 'Z').getTime();
    const lastTs = new Date(sorted[sorted.length - 1].created_at + 'Z').getTime();
    const duration = formatRelTime(lastTs - firstTs);

    const participants = new Set();
    for (const ev of sorted) {
      const s = attributedSlot(ev);
      if (s != null) participants.add(s);
    }
    // Host is implicitly participant 0 if room_created exists
    if (sorted.some((e) => e.type === 'room_created')) participants.add(0);

    const errorCounts = {};
    let totalErrors = 0;
    for (const ev of sorted) {
      if (ERROR_TYPES.has(ev.type)) {
        errorCounts[ev.type] = (errorCounts[ev.type] || 0) + 1;
        totalErrors++;
      }
    }
    const errorSummary = totalErrors
      ? Object.entries(errorCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `<span style="color:#e89">${escapeHtml(t)}×${n}</span>`)
          .join(', ')
      : '<span class="dim">no errors</span>';

    const participantBadges = [...participants]
      .sort((a, b) => a - b)
      .map(
        (s) =>
          `<span style="display:inline-block; padding:2px 8px; background:${slotColor(s)}; color:#000; border-radius:3px; font-weight:bold; font-size:11px; margin-right:4px">P${s}</span>`,
      )
      .join('');

    return `<div style="background:#0f0f1e; border:1px solid #2a2a40; border-radius:6px; padding:12px; margin:12px 0">
      <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:center; font-size:13px">
        <div><strong>Duration:</strong> ${escapeHtml(duration || '—')}</div>
        <div><strong>Events:</strong> ${escapeHtml(String(sorted.length))}</div>
        <div><strong>Participants:</strong> ${participantBadges || '<span class="dim">none</span>'}</div>
        <div><strong>Errors:</strong> ${errorSummary}</div>
      </div>
    </div>`;
  };

  // Keep the event overview, separate from on-demand screenshot comparison.
  const TIMELINE_PAD_LEFT = 80;
  const TIMELINE_PAD_RIGHT = 120;
  const MARKER_SIZE = 14;

  // Keep short sessions legible without an outsize span for older logs.
  const pickPxPerSec = (spanSec) => {
    if (spanSec < 30) return 100;
    if (spanSec < 120) return 60;
    return 40;
  };

  // Choose tick interval so ticks land roughly every 200-300px on screen,
  // regardless of session length. Multiplied with px/sec to get pixel spacing.
  const pickTickIntervalSec = (pxPerSec) => {
    // Aim for ticks every ~250 px
    const idealSec = 250 / pxPerSec;
    // Snap to a clean human-readable interval
    const clean = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    for (const c of clean) {
      if (c >= idealSec) return c;
    }
    return clean[clean.length - 1];
  };

  const renderHorizontalTimeline = (events) => {
    if (!events.length) return '';

    // Scale markers to the recorded event times.
    const allTs = [];
    for (const ev of events) allTs.push(new Date(ev.created_at + 'Z').getTime());
    const validTs = allTs.filter(Number.isFinite);
    if (!validTs.length) return '';
    const minTs = Math.min(...validTs);
    const maxTs = Math.max(...validTs);
    const span = Math.max(maxTs - minTs, 1);
    const spanSec = span / 1000;

    // Adaptive scale: chosen by session duration. See pickPxPerSec.
    const TIMELINE_PX_PER_SEC = pickPxPerSec(spanSec);

    // Linear time→pixel mapping. Every timestamp has a deterministic x
    // position independent of any other event.
    const pxPerSec = Math.min(TIMELINE_PX_PER_SEC, 60_000 / spanSec);
    const contentWidth = Math.max(1200, Math.ceil(spanSec * pxPerSec) + TIMELINE_PAD_LEFT + TIMELINE_PAD_RIGHT);
    const posLeft = (ts) => TIMELINE_PAD_LEFT + ((ts - minTs) / 1000) * pxPerSec;

    // Event markers — circles centered on the axis line. Timestamps are
    // carried by the tick labels below, so markers stay visually clean
    // (tooltip still shows full details on hover).
    const MARKER_BAR_HEIGHT = 72;
    const AXIS_Y = 20; // axis line y position inside the marker bar
    const eventMarkers = events
      .map((ev) => {
        const ts = new Date(ev.created_at + 'Z').getTime();
        const left = posLeft(ts);
        const isStage = STAGE_EVENTS.has(ev.type);
        const isLifecycle = LIFECYCLE_EVENTS.has(ev.type);
        const isErr = ERROR_TYPES.has(ev.type);
        const fill = isStage ? '#2ecc71' : isLifecycle ? '#f5c542' : isErr ? '#e74c3c' : '#888';
        const slot = attributedSlot(ev);
        const border = slot != null ? slotColor(slot) : '#444';
        const slotLabel = slot != null ? ` (P${slot})` : '';
        const rel = formatRelTime(ts - minTs);
        const title = `${ev.type}${slotLabel} ${rel}${ev.message ? ' — ' + ev.message : ''}`;
        return `<div
          class="tl-marker"
          data-ts="${ts}"
          title="${escapeHtml(title)}"
          style="position:absolute; left:${left}px; top:${AXIS_Y}px; transform:translate(-50%, -50%); width:${MARKER_SIZE}px; height:${MARKER_SIZE}px; background:${fill}; border:2px solid ${border}; border-radius:50%; cursor:pointer; box-shadow:0 0 0 2px #0f0f1e; z-index:3"
        ></div>`;
      })
      .join('');

    // Use frame labels only when the event stream can anchor them.
    const frameAnchors = [];
    for (const ev of events) {
      if (ev.type === 'emulator_booted' && typeof ev.meta?.frames === 'number') {
        frameAnchors.push({ ts: new Date(ev.created_at + 'Z').getTime(), frame: ev.meta.frames });
      }
    }
    frameAnchors.sort((a, b) => a.ts - b.ts);
    // Dedup exact-timestamp duplicates keeping the lowest frame
    const dedupAnchors = [];
    for (const a of frameAnchors) {
      if (!dedupAnchors.length || dedupAnchors[dedupAnchors.length - 1].ts !== a.ts) {
        dedupAnchors.push(a);
      }
    }
    // frameAtTs: linear interpolation between nearest anchors. Returns null
    // outside the anchored range — pre-game time has no frame number, and
    // extrapolating past the end is misleading. Only frame numbers we can
    // actually correlate to data should be displayed on the ruler.
    const frameAtTs = (ts) => {
      if (!dedupAnchors.length) return null;
      if (ts < dedupAnchors[0].ts) return null;
      if (ts > dedupAnchors[dedupAnchors.length - 1].ts) return null;
      for (let i = 1; i < dedupAnchors.length; i++) {
        if (dedupAnchors[i].ts >= ts) {
          const a = dedupAnchors[i - 1];
          const b = dedupAnchors[i];
          if (b.ts === a.ts) return a.frame;
          const frac = (ts - a.ts) / (b.ts - a.ts);
          return Math.round(a.frame + (b.frame - a.frame) * frac);
        }
      }
      return null;
    };

    // Build tick marks at fixed uniform intervals relative to minTs. Each
    // tick sits at an exact `minTs + i * interval` timestamp, placed at its
    // linearly-mapped x position. Events and screenshots land between ticks
    // at their actual time positions — exactly like a DAW ruler. Interval
    // is chosen to land roughly every ~250 px on screen.
    const TICK_INTERVAL_SEC = pickTickIntervalSec(pxPerSec);
    const ticks = [];
    // A sparse legacy match can have timestamps hours apart even in one
    // frame range. Keep the ruler bounded for that case too.
    const tickIntervalMs = Math.max(TICK_INTERVAL_SEC * 1000, Math.ceil(span / 120 / 1000) * 1000);
    // Start at tick 0 (minTs itself, i.e. T+0) and emit every interval up
    // to and including the end of the session.
    for (let i = 0; i * tickIntervalMs <= span; i++) {
      const ts = minTs + i * tickIntervalMs;
      ticks.push({ x: posLeft(ts), ts });
    }
    // Ensure the absolute end-of-session gets a tick even if it doesn't fall
    // on an interval boundary (nice for "this is where the data ends").
    const lastTickTs = minTs + (ticks.length - 1) * tickIntervalMs;
    if (lastTickTs < maxTs) {
      ticks.push({ x: posLeft(maxTs), ts: maxTs });
    }

    // Render ruler ticks INSIDE the marker bar, positioned below the axis
    // line. Each tick is a short vertical notch under the axis plus a
    // two-line label: elapsed time (top) and frame number (bottom).
    const TICK_NOTCH_TOP = AXIS_Y + MARKER_SIZE / 2 + 4;
    const TICK_NOTCH_HEIGHT = 6;
    const TICK_TIME_LABEL_Y = TICK_NOTCH_TOP + TICK_NOTCH_HEIGHT + 2;
    const TICK_FRAME_LABEL_Y = TICK_TIME_LABEL_Y + 13;
    const ruler = ticks
      .map((t) => {
        const rel = formatRelTime(t.ts - minTs);
        const frame = frameAtTs(t.ts);
        const frameLabel = frame != null ? `f${frame}` : '';
        return `<div style="position:absolute; left:${t.x}px; top:${TICK_NOTCH_TOP}px; width:1px; height:${TICK_NOTCH_HEIGHT}px; background:#666; pointer-events:none"></div>
          <div style="position:absolute; left:${t.x}px; top:${TICK_TIME_LABEL_Y}px; transform:translateX(-50%); font-size:10px; color:#aaa; white-space:nowrap; font-variant-numeric:tabular-nums; pointer-events:none">${escapeHtml(rel)}</div>
          ${frameLabel ? `<div style="position:absolute; left:${t.x}px; top:${TICK_FRAME_LABEL_Y}px; transform:translateX(-50%); font-size:9px; color:#666; white-space:nowrap; font-variant-numeric:tabular-nums; pointer-events:none">${escapeHtml(frameLabel)}</div>` : ''}`;
      })
      .join('');
    // Full-height faint gridlines at each tick position. Rendered as a
    // background layer spanning every row (screenshots + marker bar), so
    // events and screenshots can be visually aligned to the ruler above.
    const gridlines = ticks
      .map(
        (t) =>
          `<div style="position:absolute; left:${t.x}px; top:0; bottom:0; width:1px; background:#1a1a2e; pointer-events:none; z-index:0"></div>`,
      )
      .join('');

    const eventCount = events.length;
    const viewportWidth = window.innerWidth || 1200;
    const scrollNote = contentWidth > viewportWidth - 100 ? ' (scroll horizontally →)' : '';

    return `<div style="background:#0f0f1e; border:1px solid #2a2a40; border-radius:6px; padding:16px; margin:12px 0">
      <div style="font-weight:bold; margin-bottom:6px; font-size:14px">Session overview</div>
      <div class="dim" style="font-size:12px; margin-bottom:12px">
        ${escapeHtml(String(eventCount))} event${eventCount === 1 ? '' : 's'} ·
        click a marker to jump to its row below${scrollNote}
      </div>

      <div style="overflow-x:auto; overflow-y:hidden; padding-bottom:8px; border:1px solid #1a1a2e; border-radius:4px; background:#07070f">
        <div style="position:relative; width:${contentWidth}px; min-width:100%">
          ${gridlines}

          <div style="position:relative; height:${MARKER_BAR_HEIGHT}px; margin-top:8px; background:#131326; border-top:1px solid #2a2a40; border-bottom:1px solid #2a2a40">
            <div style="position:absolute; left:0; right:0; top:${AXIS_Y}px; height:2px; background:#2a2a40"></div>
            ${eventMarkers}
            ${ruler}
          </div>
        </div>
      </div>
    </div>`;
  };

  // Primary vertical timeline renderer. Pure function of the event list —
  // no state machine, no per-stage rules. Every event becomes a row, in
  // order, with slot-colored background and a clear type badge.
  //
  // Future extension points (see project_session_timeline_vision):
  //   - feedback:    interleave rows with {type:'feedback', message, ts}
  //   - input audit: anchor at first_frame_rendered with a collapsible block
  //   - sync log:    interleave per-frame sync entries
  // The renderer already operates on a flat chronological list, so adding
  // new row types is a matter of giving them a timestamp and a renderer
  // branch in the map below.
  const renderEventTimeline = (events) => {
    if (!events.length) return '';
    const sorted = [...events].sort(
      (a, b) => new Date(a.created_at + 'Z').getTime() - new Date(b.created_at + 'Z').getTime(),
    );
    const firstTs = new Date(sorted[0].created_at + 'Z').getTime();

    const rows = sorted
      .map((ev) => {
        const ts = new Date(ev.created_at + 'Z').getTime();
        const rel = formatRelTime(ts - firstTs);
        const isStage = STAGE_EVENTS.has(ev.type);
        const isLifecycle = LIFECYCLE_EVENTS.has(ev.type);
        const isErr = ERROR_TYPES.has(ev.type);

        // Type badge color by category
        const badgeColor = isStage ? '#2ecc71' : isLifecycle ? '#f5c542' : isErr ? '#e74c3c' : '#888';

        // Row tint by slot (pre-game events with no slot get no tint)
        const slot = attributedSlot(ev);
        const rowBg = isErr ? '#2a0f15' : slot != null ? slotRowTint(slot) : 'transparent';

        const slotBadge =
          slot != null
            ? `<span style="display:inline-block; padding:1px 6px; background:${slotColor(slot)}; color:#000; border-radius:3px; font-weight:bold; font-size:11px">P${slot}</span>`
            : '';

        // Meta preview: show key fields inline (bytes, peer_slot, frame, etc.)
        const metaPreview =
          ev.meta && typeof ev.meta === 'object'
            ? Object.entries(ev.meta)
                .filter(([k]) => k !== 'match_id') // redundant with the session context
                .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
                .join(' ')
            : '';

        return `<tr class="tl-row" data-ts="${ts}" style="background:${rowBg}">
          <td class="dim" style="white-space:nowrap; padding:6px 10px; font-variant-numeric:tabular-nums; border-left:3px solid ${slot != null ? slotColor(slot) : 'transparent'}">${escapeHtml(rel)}</td>
          <td style="padding:6px 10px">${slotBadge}</td>
          <td style="color:${badgeColor}; padding:6px 10px; white-space:nowrap"><strong>${escapeHtml(ev.type)}</strong></td>
          <td style="padding:6px 10px">
            ${escapeHtml(ev.message || '')}
            ${metaPreview ? `<span class="dim" style="margin-left:8px; font-size:11px">${metaPreview}</span>` : ''}
          </td>
        </tr>`;
      })
      .join('');

    return `<div style="margin:12px 0">
      <div style="font-weight:bold; margin-bottom:8px">Session timeline (${sorted.length} event${sorted.length === 1 ? '' : 's'})</div>
      <div id="tl-scroll-container" style="max-height:420px; overflow-y:auto; border:1px solid #2a2a40; border-radius:4px">
        <table style="width:100%; border-collapse:collapse; font-size:13px">
          <thead style="position:sticky; top:0; background:#1a1a2e; z-index:1">
            <tr style="border-bottom:1px solid #2a2a40">
              <th style="text-align:left; padding:6px 10px">Time</th>
              <th style="text-align:left; padding:6px 10px">Who</th>
              <th style="text-align:left; padding:6px 10px">Event</th>
              <th style="text-align:left; padding:6px 10px">Detail</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  };

  // Copy only the lightweight summary and events, never the raw log.
  const serializeSessionForCopy = (view) => {
    const { data, events } = view;

    const lines = [];
    lines.push(`=== SESSION LOG #${data.id} ===`);
    if (data.match_id) lines.push(`Match: ${data.match_id}`);
    if (data.room) lines.push(`Room: ${data.room}`);
    if (data.mode) lines.push(`Mode: ${data.mode}`);
    if (data.player_name != null) lines.push(`Player: ${data.player_name} (slot P${data.slot ?? 0})`);
    if (data.created_at) lines.push(`Created: ${data.created_at}`);
    if (data.ended_by) lines.push(`Ended by: ${data.ended_by}`);

    if (events.length) {
      const sorted = [...events].sort(
        (a, b) => new Date(a.created_at + 'Z').getTime() - new Date(b.created_at + 'Z').getTime(),
      );
      const firstTs = new Date(sorted[0].created_at + 'Z').getTime();
      const lastTs = new Date(sorted[sorted.length - 1].created_at + 'Z').getTime();
      lines.push('');
      lines.push(`Duration: ${formatRelTime(lastTs - firstTs)}, ${sorted.length} events`);

      const errorCounts = {};
      for (const ev of sorted) {
        if (ERROR_TYPES.has(ev.type)) errorCounts[ev.type] = (errorCounts[ev.type] || 0) + 1;
      }
      const errorKeys = Object.keys(errorCounts);
      if (errorKeys.length) {
        lines.push(`Errors: ${errorKeys.map((k) => `${k}×${errorCounts[k]}`).join(', ')}`);
      } else {
        lines.push('Errors: none');
      }

      lines.push('');
      lines.push('=== TIMELINE ===');
      for (const ev of sorted) {
        const ts = new Date(ev.created_at + 'Z').getTime();
        const rel = formatRelTime(ts - firstTs).padEnd(10);
        const slot = attributedSlot(ev);
        const slotStr = slot != null ? `[P${slot}]` : '[--]';
        const meta =
          ev.meta && typeof ev.meta === 'object'
            ? Object.entries(ev.meta)
                .filter(([k]) => k !== 'match_id')
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : '';
        const msg = ev.message || '';
        const detail = [msg, meta].filter(Boolean).join(' | ');
        lines.push(`${rel} ${slotStr} ${ev.type}${detail ? ' — ' + detail : ''}`);
      }
    }

    lines.push('');
    lines.push('=== SUMMARY DATA ===');
    lines.push(JSON.stringify(data, null, 2));

    return lines.join('\n');
  };

  // Input audit link (bundled with P0-1) — fetch JSON and display in viewer
  $('#session-log-list')?.addEventListener('click', async (e) => {
    const link = e.target.closest('.input-audit-link');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    const matchId = link.dataset.matchId;
    if (!matchId) return;
    resetViewer();
    const controller = new AbortController();
    auditRequest = controller;
    const viewer = $('#log-viewer');
    $('#viewer-title').textContent = `Input Audit — ${matchId.substring(0, 12)}`;
    $('#viewer-meta').innerHTML = '';
    $('#viewer-content').textContent = 'Loading...';
    viewer.classList.remove('hidden');
    viewer.scrollIntoView({ block: 'start' });
    try {
      const res = await fetchAdmin(`/admin/api/input-audit/${encodeURIComponent(matchId)}`, controller.signal);
      const data = await res.json();
      if (auditRequest === controller) $('#viewer-content').textContent = JSON.stringify(data, null, 2);
    } catch {
      if (auditRequest === controller) $('#viewer-content').textContent = 'Could not load input audit.';
    }
  });

  // -- Viewer ----------------------------------------------------------------

  $('#viewer-close').addEventListener('click', () => {
    resetViewer();
    $('#log-viewer').classList.add('hidden');
  });

  $('#viewer-copy').addEventListener('click', async () => {
    const content = sessionView?.data ? serializeSessionForCopy(sessionView) : $('#viewer-content').textContent;
    if (content && (await copyText(content))) showToast('Copied');
  });

  $('#viewer-download').addEventListener('click', async () => {
    const view = sessionView;
    if (!view?.data) return;
    const button = $('#viewer-download');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const res = await fetchAdmin(
        `/admin/api/session-logs/${encodeURIComponent(view.id)}/export`,
        view.controller.signal,
      );
      const blob = await res.blob();
      if (sessionView !== view) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `session-${view.id}.jsonl`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (sessionView === view) showToast('Could not download the raw log');
    } finally {
      if (sessionView === view) button.disabled = false;
    }
  });

  // -- Desync Events ---------------------------------------------------------

  const loadDesyncEvents = async () => {
    const matchId = ($('#desync-match-id')?.value || '').trim();
    if (!matchId) return;
    const res = await fetch(`/admin/api/desync-events?match_id=${encodeURIComponent(matchId)}`, { headers: headers() });
    if (!res.ok) {
      showToast(`Load failed: ${res.status}`);
      return;
    }
    const body = await res.json();
    const list = $('#desync-event-list');
    const empty = $('#no-desync-events');
    const resultRows = body.match_id === matchId ? (body.events || []).filter(hasVisionCaptureEvidence) : [];
    if (!resultRows.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }
    empty?.classList.add('hidden');
    list.innerHTML = resultRows
      .map((e) => {
        const summary = e.vision_equal ? 'no mismatch found' : 'mismatch flagged';
        return `<li>Separate vision comparison: ${summary} in captures tagged frame ${escapeHtml(String(e.captured_frame))}.</li>`;
      })
      .join('');
  };

  $('#desync-load-btn')?.addEventListener('click', loadDesyncEvents);
  $('#desync-match-id')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadDesyncEvents();
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
    resetViewer();
    $('#log-viewer').classList.remove('hidden');
    $('#viewer-title').textContent = `Event #${id} — ${evt.type}`;
    $('#viewer-meta').innerHTML = '';
    $('#viewer-content').textContent = JSON.stringify(evt, null, 2);
    $('#log-viewer').scrollIntoView({ behavior: 'smooth' });
  });

  $('#refresh-btn').addEventListener('click', () => loadAll());

  init();
})();
