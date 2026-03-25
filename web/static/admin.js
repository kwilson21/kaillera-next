(function () {
  'use strict';

  let adminKey = localStorage.getItem('kn-admin-key') || '';

  const $ = (sel) => document.querySelector(sel);

  // ── Auth ──────────────────────────────────────────────────────────────

  const headers = () => adminKey ? { 'X-Admin-Key': adminKey } : {};

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
    ].map((c) => `<div class="stat-card"><div class="label">${c.label}</div><div class="value">${c.value}</div></div>`).join('');
  };

  // ── Logs ──────────────────────────────────────────────────────────────

  const timeAgo = (ts) => {
    const diff = (Date.now() / 1000) - ts;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  const escapeHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let currentLogs = [];

  const loadLogs = async () => {
    const res = await fetch('/admin/api/logs', { headers: headers() });
    if (!res.ok) return;
    currentLogs = await res.json();
    renderLogs();
  };

  const renderLogs = () => {
    const tbody = $('#log-body');
    const noLogs = $('#no-logs');

    if (currentLogs.length === 0) {
      tbody.innerHTML = '';
      noLogs.classList.remove('hidden');
      return;
    }
    noLogs.classList.add('hidden');

    tbody.innerHTML = currentLogs.map((l) => {
      const srcClass = l.source !== 'normal' ? ` ${escapeHtml(l.source)}` : '';
      const fn = escapeHtml(l.filename);
      const rm = escapeHtml(l.room);
      const src = escapeHtml(l.source);
      return `<tr data-filename="${fn}">
        <td><button class="btn-pin${l.pinned ? ' pinned' : ''}" data-action="pin" data-file="${fn}" title="${l.pinned ? 'Unpin' : 'Pin'}">${l.pinned ? '\u2605' : '\u2606'}</button></td>
        <td>${rm}</td>
        <td>P${escapeHtml(l.slot)}</td>
        <td><span class="source-badge${srcClass}">${src}</span></td>
        <td>${formatBytes(l.size)}</td>
        <td title="${new Date(l.created * 1000).toLocaleString()}">${timeAgo(l.created)}</td>
        <td><button class="btn-small btn-danger" data-action="delete" data-file="${fn}">Delete</button></td>
      </tr>`;
    }).join('');
  };

  // ── Log viewer ────────────────────────────────────────────────────────

  const viewLog = async (filename) => {
    const viewer = $('#log-viewer');
    const content = $('#viewer-content');
    const title = $('#viewer-title');

    title.textContent = filename;
    content.textContent = 'Loading...';
    viewer.classList.remove('hidden');

    const res = await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, { headers: headers() });
    if (!res.ok) {
      content.textContent = `Error: ${res.status} ${res.statusText}`;
      return;
    }
    content.textContent = await res.text();
    viewer.scrollIntoView({ behavior: 'smooth' });
  };

  $('#viewer-close').addEventListener('click', () => {
    $('#log-viewer').classList.add('hidden');
  });

  // ── Actions ───────────────────────────────────────────────────────────

  const pinLog = async (filename, currentlyPinned) => {
    const method = currentlyPinned ? 'DELETE' : 'POST';
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}/pin`, { method, headers: headers() });
    await loadLogs();
  };

  const deleteLog = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    await fetch(`/admin/api/logs/${encodeURIComponent(filename)}`, { method: 'DELETE', headers: headers() });
    if ($('#viewer-title').textContent === filename) {
      $('#log-viewer').classList.add('hidden');
    }
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

  $('#log-table').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      e.stopPropagation();
      const file = btn.dataset.file;
      if (btn.dataset.action === 'pin') {
        const entry = currentLogs.find((l) => l.filename === file);
        pinLog(file, entry?.pinned);
      } else if (btn.dataset.action === 'delete') {
        deleteLog(file);
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
