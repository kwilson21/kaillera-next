(() => {
  let _changelog = null;

  const fetchVersion = async () => {
    try {
      const res = await fetch(`/static/version.json?_t=${Date.now()}`);
      const data = await res.json();
      for (const el of document.querySelectorAll('#kn-version')) {
        el.textContent = `v${data.version}`;
        el.addEventListener('click', showChangelog);
      }
    } catch (_) {}
  };

  const showChangelog = async () => {
    if (!_changelog) {
      try {
        const res = await fetch(`/static/changelog.json?_t=${Date.now()}`);
        _changelog = await res.json();
      } catch (_) {
        return;
      }
    }
    renderModal(_changelog);
  };

  const renderModal = (changelog) => {
    // Remove existing modal if any
    document.getElementById('kn-changelog-modal')?.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'kn-changelog-modal';
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '99999',
      padding: '20px',
    });

    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#1a1a2e',
      border: '1px solid #333',
      borderRadius: '12px',
      maxWidth: '520px',
      width: '100%',
      maxHeight: '80vh',
      overflow: 'auto',
      padding: '24px',
      color: '#ccc',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '14px',
    });

    // Header
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '16px',
    });
    const title = document.createElement('h2');
    title.textContent = 'Changelog';
    Object.assign(title.style, { margin: '0', color: '#fff', fontSize: '18px' });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u00d7';
    Object.assign(closeBtn.style, {
      background: 'none',
      border: 'none',
      color: '#888',
      fontSize: '24px',
      cursor: 'pointer',
      padding: '0 4px',
    });
    closeBtn.addEventListener('click', () => backdrop.remove());
    header.append(title, closeBtn);
    card.appendChild(header);

    // Versions
    changelog.forEach((release, i) => {
      const section = document.createElement('div');
      section.style.marginBottom = '12px';

      const vHeader = document.createElement('div');
      Object.assign(vHeader.style, {
        cursor: 'pointer',
        padding: '8px 0',
        borderBottom: '1px solid #333',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      });

      const vLabel = document.createElement('span');
      vLabel.innerHTML = `<strong style="color:#fff">v${release.version}</strong> <span style="color:#666;margin-left:8px">${release.date}</span>`;
      const arrow = document.createElement('span');
      arrow.textContent = i === 0 ? '\u25BC' : '\u25B6';
      arrow.style.color = '#666';
      vHeader.append(vLabel, arrow);

      const list = document.createElement('ul');
      Object.assign(list.style, {
        margin: '8px 0 0 0',
        padding: '0 0 0 20px',
        display: i === 0 ? 'block' : 'none',
      });

      for (const change of release.changes) {
        const li = document.createElement('li');
        li.style.marginBottom = '4px';
        const prefix =
          change.type === 'feat'
            ? '<span style="color:#4ade80">+</span> '
            : '<span style="color:#f59e0b">\u2022</span> ';
        li.innerHTML = prefix + escapeHtml(change.message);
        list.appendChild(li);
      }

      vHeader.addEventListener('click', () => {
        const visible = list.style.display !== 'none';
        list.style.display = visible ? 'none' : 'block';
        arrow.textContent = visible ? '\u25B6' : '\u25BC';
      });

      section.append(vHeader, list);
      card.appendChild(section);
    });

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // Close on backdrop click
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    // Close on Escape
    const onKey = (e) => {
      if (e.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  };

  const escapeHtml = (s) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, (c) => map[c]);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchVersion);
  } else {
    fetchVersion();
  }
})();
