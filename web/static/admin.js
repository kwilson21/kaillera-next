(function () {
  'use strict';

  let adminKey = localStorage.getItem('kn-admin-key') || '';

  const $ = (sel) => document.querySelector(sel);

  // ── Auth ──────────────────────────────────────────────────────────────

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
    localStorage.setItem('kn-admin-key', adminKey);
    const ok = await checkAuth();
    if (!ok) {
      $('#auth-error').classList.remove('hidden');
      localStorage.removeItem('kn-admin-key');
      adminKey = '';
    } else {
      $('#auth-error').classList.add('hidden');
      loadAll();
    }
  });

  $('#admin-key-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#auth-btn').click();
  });

  // ── Stats ─────────────────────────────────────────────────────────────

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
      { label: 'Log Files', value: s.log_count },
      { label: 'Log Size', value: formatBytes(s.log_size_bytes) },
      { label: 'Retention', value: `${s.retention_days}d` },
    ]
      .map((c) => `<div class="stat-card"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`)
      .join('');
  };

  // ── Logs ──────────────────────────────────────────────────────────────

  const timeAgo = (ts) => {
    const diff = Date.now() / 1000 - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  const escapeHtml = (str) =>
    str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let currentLogs = [];
  // Cache of fetched log contents: filename -> text
  const logContentCache = {};

  const loadLogs = async () => {
    const res = await fetch('/admin/api/logs', { headers: headers() });
    if (!res.ok) return;
    currentLogs = await res.json();
    renderLogs();
  };

  const groupByRoom = (logs) => {
    const groups = {};
    for (const log of logs) {
      const room = log.room || 'unknown';
      if (!groups[room]) groups[room] = [];
      groups[room].push(log);
    }
    // Sort groups by most recent log
    return Object.entries(groups).sort((a, b) => {
      const aMax = Math.max(...a[1].map((l) => l.created));
      const bMax = Math.max(...b[1].map((l) => l.created));
      return bMax - aMax;
    });
  };

  const renderLogs = () => {
    const container = $('#log-groups');
    const noLogs = $('#no-logs');

    if (currentLogs.length === 0) {
      container.innerHTML = '';
      noLogs.classList.remove('hidden');
      return;
    }
    noLogs.classList.add('hidden');

    const groups = groupByRoom(currentLogs);
    container.innerHTML = groups
      .map(([room, logs]) => {
        const newest = Math.max(...logs.map((l) => l.created));
        const totalSize = logs.reduce((sum, l) => sum + l.size, 0);
        const slots = [...new Set(logs.map((l) => l.slot))].sort().join(', ');

        const rows = logs
          .map((l) => {
            const fn = escapeHtml(l.filename);
            const srcClass = l.source !== 'normal' ? ` ${escapeHtml(l.source)}` : '';
            const src = escapeHtml(l.source);
            return `<tr data-filename="${fn}">
          <td><button class="btn-pin${l.pinned ? ' pinned' : ''}" data-action="pin" data-file="${fn}" title="${l.pinned ? 'Unpin' : 'Pin'}">${l.pinned ? '\u2605' : '\u2606'}</button></td>
          <td>P${escapeHtml(l.slot)}</td>
          <td><span class="source-badge${srcClass}">${src}</span></td>
          <td>${formatBytes(l.size)}</td>
          <td title="${new Date(l.created * 1000).toLocaleString()}">${timeAgo(l.created)}</td>
          <td class="action-cell">
            <button class="btn-small" data-action="copy-one" data-file="${fn}" title="Copy log">Copy</button>
            <button class="btn-small btn-danger" data-action="delete" data-file="${fn}">Del</button>
          </td>
        </tr>`;
          })
          .join('');

        return `<div class="room-group" data-room="${escapeHtml(room)}">
        <div class="room-header">
          <div class="room-info">
            <span class="room-code">${escapeHtml(room)}</span>
            <span class="room-meta">${logs.length} log${logs.length > 1 ? 's' : ''} &middot; P${slots} &middot; ${formatBytes(totalSize)} &middot; ${timeAgo(newest)}</span>
          </div>
          <button class="btn-small" data-action="copy-room" data-room="${escapeHtml(room)}" title="Copy all logs for this room as JSON">Copy Room JSON</button>
        </div>
        <table>
          <thead><tr>
            <th>Pin</th><th>Slot</th><th>Source</th><th>Size</th><th>Date</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
      })
      .join('');
  };

  // ── Log viewer ────────────────────────────────────────────────────────

  const parseDiagStart = (text) => {
    const match = text.match(/DIAG-START\s+slot=(\d+)\s+engine=(\S+)\s+mobile=(\S+)\s+forkedCore=(\S+)\s+ua=(.+)/);
    if (!match) return null;
    return {
      slot: match[1],
      engine: match[2],
      mobile: match[3] === 'true',
      forkedCore: match[4] === 'true',
      ua: match[5].trim(),
    };
  };

  const parseGameEvents = (text) => {
    const events = [];
    const patterns = [
      [/lockstep started/, 'Lockstep started'],
      [/Connected -- game on!/, 'Game started (lockstep)'],
      [/Connected — streaming!/, 'Game started (streaming)'],
      [/Hosting — game on!/, 'Hosting (streaming)'],
      [/DESYNC frame=(\d+)/, (m) => `Desync at frame ${m[1]}`],
      [/sync #(\d+) applied.*frame (\d+)/, (m) => `Resync #${m[1]} (frame ${m[2]})`],
      [/INPUT-STALL resend-request/, 'Input stall (resend)'],
      [/game-ended/, 'Game ended'],
      [/DC closed/, 'Peer disconnected'],
      [/boot slot=\d+ f=\d+\/120/, null], // skip boot progress
      [/emulator ready/, 'Emulator ready'],
      [/Syncing\.\.\./, 'State sync started'],
      [/state cached/, 'State cached'],
      [/lockstep-ready -- GO/, 'All players ready'],
    ];

    for (const line of text.split('\n')) {
      for (const [re, label] of patterns) {
        if (!label) continue;
        const m = line.match(re);
        if (m) {
          events.push(typeof label === 'function' ? label(m) : label);
          break;
        }
      }
    }
    return events;
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

  const fetchLogContent = async (filename) => {
    if (logContentCache[filename]) return logContentCache[filename];
    const res = await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, {
      headers: headers(),
    });
    if (!res.ok) return null;
    const text = await res.text();
    logContentCache[filename] = text;
    return text;
  };

  let _currentViewerFilename = null;

  const viewLog = async (filename) => {
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const title = $('#viewer-title');
    const meta = $('#viewer-meta');

    _currentViewerFilename = filename;
    title.textContent = filename;
    meta.innerHTML = '';
    content.textContent = 'Loading...';
    viewer.classList.remove('hidden');

    const text = await fetchLogContent(filename);
    if (!text) {
      content.textContent = 'Error loading log';
      return;
    }
    content.textContent = text;

    // Parse and show metadata
    const diag = parseDiagStart(text);
    const events = parseGameEvents(text);
    const parts = [];
    if (diag) {
      parts.push(
        `<span class="meta-tag">${diag.mobile ? 'Mobile' : 'Desktop'}</span>`,
        `<span class="meta-tag">${formatUserAgent(diag.ua)}</span>`,
        `<span class="meta-tag">${diag.engine}</span>`,
        `<span class="meta-tag ${diag.forkedCore ? 'meta-ok' : 'meta-warn'}">${diag.forkedCore ? 'Patched core' : 'Stock core'}</span>`,
      );
    }
    if (events.length) {
      parts.push(`<span class="meta-events">${events.join(' &rarr; ')}</span>`);
    }
    meta.innerHTML = parts.join('');

    viewer.scrollIntoView({ behavior: 'smooth' });
  };

  $('#viewer-close').addEventListener('click', () => {
    $('#log-viewer').classList.add('hidden');
    _currentViewerFilename = null;
  });

  $('#viewer-copy').addEventListener('click', () => {
    const content = $('#viewer-content').textContent;
    if (content) {
      navigator.clipboard.writeText(content);
      showToast('Log copied');
    }
  });

  // ── Copy helpers ────────────────────────────────────────────────────

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

  const copyOneLog = async (filename) => {
    const text = await fetchLogContent(filename);
    if (text) {
      navigator.clipboard.writeText(text);
      showToast('Log copied');
    }
  };

  const copyRoomJson = async (room) => {
    const roomLogs = currentLogs.filter((l) => l.room === room);
    if (!roomLogs.length) return;

    showToast('Fetching logs...');

    const entries = await Promise.all(
      roomLogs.map(async (l) => {
        const text = await fetchLogContent(l.filename);
        const diag = text ? parseDiagStart(text) : null;
        const events = text ? parseGameEvents(text) : [];
        return {
          slot: parseInt(l.slot, 10),
          source: l.source,
          device: diag
            ? {
                mobile: diag.mobile,
                browser: formatUserAgent(diag.ua),
                engine: diag.engine,
                forkedCore: diag.forkedCore,
                ua: diag.ua,
              }
            : null,
          events,
          content: text || '',
        };
      }),
    );

    // Sort by slot
    entries.sort((a, b) => a.slot - b.slot);

    const json = JSON.stringify({ room, timestamp: new Date().toISOString(), logs: entries }, null, 2);
    navigator.clipboard.writeText(json);
    showToast(`Copied ${entries.length} log${entries.length > 1 ? 's' : ''} as JSON`);
  };

  // ── Actions ─────────────────────────────────────────────────────────

  const pinLog = async (filename, currentlyPinned) => {
    const method = currentlyPinned ? 'DELETE' : 'POST';
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}/pin`, {
      method,
      headers: headers(),
    });
    await loadLogs();
  };

  const deleteLog = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (_currentViewerFilename === filename) {
      $('#log-viewer').classList.add('hidden');
      _currentViewerFilename = null;
    }
    delete logContentCache[filename];
    await loadLogs();
  };

  // ── Init ──────────────────────────────────────────────────────────────

  const loadAll = async () => {
    await loadStats();
    await loadLogs();
  };

  const init = async () => {
    const ok = await checkAuth();
    if (ok) loadAll();
  };

  // ── Event delegation ──────────────────────────────────────────────────

  $('#log-groups').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      e.stopPropagation();
      const file = btn.dataset.file;
      const action = btn.dataset.action;
      if (action === 'pin') {
        const entry = currentLogs.find((l) => l.filename === file);
        pinLog(file, entry?.pinned);
      } else if (action === 'delete') {
        deleteLog(file);
      } else if (action === 'copy-one') {
        copyOneLog(file);
      } else if (action === 'copy-room') {
        copyRoomJson(btn.dataset.room);
      }
      return;
    }
    const row = e.target.closest('tr[data-filename]');
    if (row) viewLog(row.dataset.filename);
  });

  $('#refresh-btn').addEventListener('click', () => loadAll());

  $('#cleanup-btn').addEventListener('click', async () => {
    if (!confirm('Delete all unpinned logs older than the retention period?')) return;
    const res = await fetch('/admin/api/cleanup', { method: 'POST', headers: headers() });
    if (res.ok) {
      const data = await res.json();
      if (data.deleted > 0) {
        console.log(`[admin] cleaned up ${data.deleted} log(s)`);
      }
    }
    await loadAll();
  });

  init();
})();
