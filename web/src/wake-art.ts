/** Small decorative animation shared by the static front and invite pages. */

export function nextWakeView(current: number, viewCount: number): number {
  return (current + 1) % viewCount;
}

export function wakeDotColumns(width: number): number {
  return Math.min(40, Math.max(1, Math.floor((width - 15 + 6) / 13)));
}

const dotRows = ['p1', 'p2', 'p3', 'p4'];

function createStage(): HTMLDivElement {
  const stage = document.createElement('div');
  stage.className = 'wake-art';
  stage.setAttribute('aria-hidden', 'true');
  stage.innerHTML = `
    <div class="wake-art-view is-active" data-art="a">
      <div class="wake-ports">
        <div class="wake-port p1"><span class="wake-port-label">P1</span><i></i><b></b></div>
        <div class="wake-port p2"><span class="wake-port-label">P2</span><i></i><b></b></div>
        <div class="wake-port p3"><span class="wake-port-label">P3</span><i></i><b></b></div>
        <div class="wake-port p4"><span class="wake-port-label">P4</span><i></i><b></b></div>
      </div>
    </div>
    <div class="wake-art-view" data-art="c">
      <div class="wake-dots">
        ${dotRows.map((color) => `<div class="wake-dot-row ${color}"></div>`).join('')}
      </div>
    </div>
    <div class="wake-art-view wake-rollback" data-art="b">
      <svg class="rb" viewBox="-2 0 70 30" aria-hidden="true" focusable="false">
        <rect x="0" y="17" width="64" height="1" class="axis" />
        <rect class="t" x="2" y="8" width="2" height="8" />
        <rect class="t" x="8" y="8" width="2" height="8" />
        <rect class="t" x="14" y="8" width="2" height="8" />
        <rect class="t" x="20" y="8" width="2" height="8" />
        <rect class="t t4" x="26" y="8" width="2" height="8" />
        <rect class="t t5" x="32" y="8" width="2" height="8" />
        <rect class="t t6" x="38" y="8" width="2" height="8" />
        <rect class="t" x="44" y="8" width="2" height="8" />
        <rect class="t" x="50" y="8" width="2" height="8" />
        <rect class="t" x="56" y="8" width="2" height="8" />
        <rect class="t" x="62" y="8" width="2" height="8" />
        <rect class="head" x="1" y="5" width="4" height="14" rx="1" />
        <text class="lbl bad" x="39" y="26" text-anchor="middle">wrong guess</text>
        <text class="lbl re" x="27" y="26" text-anchor="middle">rewind · replay</text>
      </svg>
    </div>`;
  return stage;
}

export function startWakeArt(): void {
  const waking = document.querySelector<HTMLElement>('#st-waking, #inv-waking');
  const progress = waking?.querySelector<HTMLElement>('.prog');
  if (!waking || !progress) return;
  const wakingSection = waking;

  const stage = createStage();
  progress.after(stage);

  const dots = stage.querySelector<HTMLElement>('.wake-dots');
  if (!dots) return;
  const dotContainer = dots;
  function sizeDotRows(): void {
    const columns = wakeDotColumns(dotContainer.clientWidth);
    dotContainer.querySelectorAll('.wake-dot-row').forEach((row) => {
      row.replaceChildren(
        ...Array.from({ length: columns }, (_, index) => {
          const dot = document.createElement('i');
          dot.style.setProperty('--dot-index', String(index));
          return dot;
        }),
      );
    });
  }
  sizeDotRows();
  new ResizeObserver(sizeDotRows).observe(dotContainer);

  const views = [...stage.querySelectorAll<HTMLElement>('.wake-art-view')];
  const ports = [...stage.querySelectorAll<HTMLElement>('.wake-port')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const cycleMs = Number(window.__KN_WAKE_ART_CYCLE_MS__ ?? 8000);
  let timer: number | null = null;
  let portTimers: number[] = [];
  let current = 0;

  function show(index: number): void {
    current = index;
    views.forEach((view, i) => {
      view.classList.toggle('is-active', i === index);
    });
  }

  if (cycleMs === 0) window.__KN_WAKE_ART_STEP__ = () => show(nextWakeView(current, views.length));

  function stop(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    portTimers.forEach((handle) => {
      window.clearTimeout(handle);
    });
    portTimers = [];
    ports.forEach((port) => {
      port.classList.remove('is-lit');
    });
    show(0);
  }

  function startPorts(): void {
    portTimers = [];
    ports.forEach((port, index) => {
      portTimers.push(window.setTimeout(() => port.classList.add('is-lit'), index * 500));
    });
    portTimers.push(
      window.setTimeout(() => {
        ports.forEach((port) => {
          port.classList.remove('is-lit');
        });
      }, 2600),
    );
    portTimers.push(window.setTimeout(startPorts, 3200));
  }

  function schedule(): void {
    if (cycleMs === 0) return;
    timer = window.setTimeout(() => {
      show(nextWakeView(current, views.length));
      schedule();
    }, cycleMs);
  }

  function sync(): void {
    stop();
    stage.classList.toggle('is-waking', !wakingSection.hidden);
    if (!wakingSection.hidden && !reducedMotion.matches) {
      startPorts();
      schedule();
    }
  }

  new MutationObserver(sync).observe(wakingSection, { attributes: true, attributeFilter: ['hidden'] });
  reducedMotion.addEventListener?.('change', sync);
  sync();
}

declare global {
  interface Window {
    __KN_WAKE_ART_CYCLE_MS__?: number;
    __KN_WAKE_ART_STEP__?: () => void;
  }
}
