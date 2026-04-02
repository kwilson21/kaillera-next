(function () {
  'use strict';

  let adminKey = KNStorage.get('localStorage', 'kn-admin-key') || '';

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
    KNStorage.set('localStorage', 'kn-admin-key', adminKey);
    const ok = await checkAuth();
    if (!ok) {
      $('#auth-error').classList.remove('hidden');
      KNStorage.remove('localStorage', 'kn-admin-key');
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
      { label: 'Active Rooms', value: `${s.rooms} / ${s.max_rooms}` },
      { label: 'Players', value: s.players },
      { label: 'Spectators', value: s.spectators },
      { label: 'Session Logs', value: s.session_log_count ?? 0 },
      { label: 'Client Events', value: s.client_event_count ?? 0 },
      { label: 'Feedback', value: s.feedback_count ?? 0 },
      { label: 'Retention', value: `${s.retention_days}d` },
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
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
            return `<tr data-session-log-id="${l.id}">
            <td>P${l.slot ?? '?'}</td>
            <td>${escapeHtml(l.player_name || '-')}</td>
            <td>${duration}</td>
            <td>${issues}</td>
            <td><span style="color:${endedColor}">${l.ended_by || 'active'}</span></td>
            <td title="${l.updated_at}">${l.updated_at ? timeAgo(new Date(l.updated_at + 'Z').getTime() / 1000) : '-'}</td>
          </tr>`;
          })
          .join('');

        return `<div class="room-group">
        <div class="room-header">
          <div class="room-info">
            <span class="room-code">${escapeHtml(room)}</span>
            <span class="room-meta">${logs.length} player${logs.length > 1 ? 's' : ''} &middot; ${logs[0].mode || 'unknown'}</span>
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

  const viewSessionLog = async (id) => {
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
    viewer.scrollIntoView({ behavior: 'smooth' });
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
        return `<div class="feedback-card" data-event-id="${e.id}">
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
        if (ctx.page) metaParts.push(ctx.page);
        if (ctx.roomCode) metaParts.push(`Room: ${escapeHtml(ctx.roomCode)}`);
        if (ctx.mode) metaParts.push(ctx.mode);
        if (ctx.peerCount != null) metaParts.push(`${ctx.peerCount} peer${ctx.peerCount !== 1 ? 's' : ''}`);
        if (ctx.userAgent) metaParts.push(formatUserAgent(ctx.userAgent));

        const sessionStats = ctx.sessionStats;
        const statsParts = [];
        if (sessionStats) {
          if (sessionStats.desyncs)
            statsParts.push(`${sessionStats.desyncs} desync${sessionStats.desyncs > 1 ? 's' : ''}`);
          if (sessionStats.stalls) statsParts.push(`${sessionStats.stalls} stall${sessionStats.stalls > 1 ? 's' : ''}`);
          if (sessionStats.reconnects)
            statsParts.push(`${sessionStats.reconnects} reconnect${sessionStats.reconnects > 1 ? 's' : ''}`);
        }

        const created = fb.created_at ? new Date(fb.created_at + 'Z').toLocaleString() : '';

        return `<div class="feedback-card" data-feedback-id="${fb.id}">
          <div class="feedback-header">
            <span class="source-badge" style="border-color:${color};color:${color}">${emoji} ${escapeHtml(fb.category)}</span>
            <span class="feedback-date" title="${created}">${created ? timeAgo(new Date(fb.created_at + 'Z').getTime() / 1000) : ''}</span>
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
    viewer.scrollIntoView({ behavior: 'smooth' });
  });

  // -- Viewer ----------------------------------------------------------------

  $('#viewer-close').addEventListener('click', () => {
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
