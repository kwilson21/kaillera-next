(() => {
  let _changelog = null;
  let _currentVersion = null;

  const VERSION_DEDICATIONS = {
    '0.21.0': "Agent's Version",
  };

  const fetchVersion = async () => {
    for (const el of document.querySelectorAll('#kn-about')) {
      el.addEventListener('click', showAbout);
    }
    try {
      const res = await fetch(`/static/version.json?_t=${Date.now()}`);
      const data = await res.json();
      _currentVersion = data.version;
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
      vLabel.innerHTML = `<strong style="color:#fff">v${escapeHtml(release.version)}</strong> <span style="color:#666;margin-left:8px">${escapeHtml(release.date)}</span>`;
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

  // ── About modal ──────────────────────────────────────────────────────

  const LINEAGE = [
    ['Kaillera (2001)', 'Christophe Thibault'],
    ['EmuLinker', 'Moosehead'],
    ['EmuLinker SF', 'Suprafast'],
    ['SupraClient', 'Suprafast'],
    ['n02 p2p', 'Jugoso, Killer Civilian'],
    ['Project64k', 'Hotquik'],
    ['AQZ NetPlay', 'CoderTimZ, CEnnis91'],
    ['Ownasaurus Client', 'Ownasaurus'],
    ['EmuLinker X', 'Near, Firo, Ownasaurus, Agent 21'],
    ['EmuLinker-K', 'hopskipnfall'],
    ['Kaillera Reborn', 'God-Weapon & community'],
    ['kaillera-next', 'Agent 21'],
  ];

  const STORY_PARAGRAPHS = [
    `It started at my grandparents' house. I was bored with nothing to do when my grandfather asked if I wanted to play Sonic. There was no Sega in sight — he pointed me to the PC. A data CD on the desk had a Sega emulator and some ROMs. I figured out how to set it up and played Sonic on an emulator for the first time.`,
    `A year or two later, I got curious at home and found the same emulator online. That led me to Project64, where I discovered I could play Super Smash Bros. 64 — a game I'd only played once as a kid and always wanted to play again.`,
    `Then I found the netplay tab. That's how I discovered Kaillera — and started playing SSB64 online with people from all over. I made a lot of friends through that community.`,
    `I always wanted to fix the problems with the emulator, the server, and the clients. But I was only 9 to 12 years old. Learning C++ and Java felt impossible. I got involved with the community efforts to improve things as best I could, eventually moved on, but never forgot about it.`,
    `Now, with the help of AI, I'm finally building what I always wanted Kaillera to be.`,
  ];

  const showAbout = () => {
    document.getElementById('kn-about-modal')?.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'kn-about-modal';
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
    title.textContent = 'kaillera-next';
    Object.assign(title.style, { margin: '0', color: '#c9a227', fontSize: '20px' });
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

    // Version dedication
    const dedication = VERSION_DEDICATIONS[_currentVersion];
    if (dedication) {
      const dedLine = document.createElement('div');
      dedLine.textContent = `v${_currentVersion} \u2014 ${dedication}`;
      Object.assign(dedLine.style, {
        color: '#c9a227',
        fontSize: '13px',
        marginBottom: '16px',
        fontStyle: 'italic',
      });
      card.appendChild(dedLine);
    }

    // Lineage
    const lineageEl = document.createElement('div');
    lineageEl.style.marginBottom = '16px';
    for (const [project, author] of LINEAGE) {
      const row = document.createElement('div');
      row.style.marginBottom = '4px';
      row.innerHTML = `<strong style="color:#fff">${escapeHtml(project)}</strong> <span style="color:#888">\u2014 ${escapeHtml(author)}</span>`;
      lineageEl.appendChild(row);
    }
    const communityLine = document.createElement('div');
    communityLine.textContent = '...and the countless others who kept Kaillera alive';
    Object.assign(communityLine.style, { color: '#666', fontStyle: 'italic', marginTop: '8px' });
    lineageEl.appendChild(communityLine);
    card.appendChild(lineageEl);

    // Links
    const links = document.createElement('div');
    Object.assign(links.style, { marginBottom: '16px', display: 'flex', gap: '16px' });
    for (const [label, url] of [
      ['GitHub', 'https://github.com/kwilson21/kaillera-next'],
      ['Support (Ko-fi)', 'https://ko-fi.com/kazonwilson'],
    ]) {
      const a = document.createElement('a');
      a.textContent = label;
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      Object.assign(a.style, { color: '#c9a227', textDecoration: 'none', fontSize: '13px' });
      links.appendChild(a);
    }
    card.appendChild(links);

    // Expandable story
    const storyHeader = document.createElement('div');
    Object.assign(storyHeader.style, {
      cursor: 'pointer',
      padding: '8px 0',
      borderTop: '1px solid #333',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    });
    const storyLabel = document.createElement('span');
    storyLabel.textContent = 'The Story';
    storyLabel.style.color = '#fff';
    const storyArrow = document.createElement('span');
    storyArrow.textContent = '\u25B6';
    storyArrow.style.color = '#666';
    storyHeader.append(storyLabel, storyArrow);

    const storyBody = document.createElement('div');
    storyBody.style.display = 'none';
    for (const text of STORY_PARAGRAPHS) {
      const p = document.createElement('p');
      p.textContent = text;
      Object.assign(p.style, { margin: '0 0 10px 0', lineHeight: '1.5', color: '#aaa' });
      storyBody.appendChild(p);
    }

    storyHeader.addEventListener('click', () => {
      const visible = storyBody.style.display !== 'none';
      storyBody.style.display = visible ? 'none' : 'block';
      storyArrow.textContent = visible ? '\u25B6' : '\u25BC';
    });

    card.append(storyHeader, storyBody);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    const onKey = (e) => {
      if (e.key === 'Escape') {
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchVersion);
  } else {
    fetchVersion();
  }
})();
