// requestVideoFrameCallback reports submissions to the local capture video's
// compositor. It cannot tell when the original game canvas reached the screen.
interface Tick {
  at: number;
  path: string;
  total: number;
}

interface Options {
  frame: () => number;
  captureAllowed: () => boolean;
  ticks?: () => readonly Tick[];
}

interface Gap {
  ms: number;
  fromAt: number;
  toAt: number;
  fromFrame: number;
  toFrame: number;
  ticks: { paths: Record<string, number>; maxMs: number } | null;
}

const rounded = (value: number) => Math.round(value * 100) / 100;

const ticksDuring = (gap: Gap, ticks: readonly Tick[]) => {
  const paths: Record<string, number> = {};
  let maxMs = 0;
  for (const tick of ticks) {
    if (tick.at <= gap.fromAt || tick.at > gap.toAt) continue;
    paths[tick.path] = (paths[tick.path] ?? 0) + 1;
    maxMs = Math.max(maxMs, tick.total);
  }
  return { paths, maxMs: rounded(maxMs) };
};

export function start(canvas: HTMLCanvasElement | null, options: Options) {
  const doc = canvas?.ownerDocument ?? document;
  const video = doc.createElement('video');
  const owner = doc.defaultView ?? window;
  const now = () => owner.performance.now();
  const recent: number[] = [];
  const worst: Gap[] = [];
  let samples = 0;
  let missedCallbacks = 0;
  let status = 'waiting-for-frame';
  let stream: MediaStream | null = null;
  let callback = 0;
  let visibleFrom = now();
  let previous: { at: number; frame: number; presented: number } | null = null;
  let pendingTicks = false;

  const resolveTicks = () => {
    if (!pendingTicks || !options.ticks) return;
    const ticks = options.ticks();
    const first = ticks[0];
    const last = ticks.at(-1);
    if (!first || !last) return;
    pendingTicks = false;
    for (const gap of worst) {
      if (gap.ticks || first.at > gap.fromAt) continue;
      if (last.at < gap.toAt) {
        pendingTicks = true;
      } else {
        // Keep the result after the engine's tick ring rolls over.
        gap.ticks = ticksDuring(gap, ticks);
      }
    }
  };

  const onVisibility = () => {
    previous = null;
    visibleFrom = now();
  };
  const end = (reason: string) => {
    if (status !== 'waiting-for-frame' && status !== 'measuring') return;
    status = reason;
    owner.removeEventListener('kn-capture-change', onCaptureChange);
    doc.removeEventListener('visibilitychange', onVisibility);
    video.removeEventListener('error', onError);
    if (callback) video.cancelVideoFrameCallback(callback);
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', onEnded);
      track.stop();
    }
    video.srcObject = null;
    video.remove();
  };
  const onCaptureChange = () => {
    if (!options.captureAllowed()) end('capture-disabled');
  };
  const onError = () => end('capture-failed');
  const onEnded = () => end('track-ended');

  const observe: VideoFrameRequestCallback = (_, meta) => {
    callback = 0;
    if (status !== 'measuring' && status !== 'waiting-for-frame') return;
    if (!options.captureAllowed()) return end('capture-disabled');
    const at = meta.presentationTime;
    if (!doc.hidden && at >= visibleFrom) {
      const frame = options.frame();
      if (previous && at > previous.at) {
        const presented = meta.presentedFrames - previous.presented;
        if (presented === 1) {
          const ms = at - previous.at;
          recent[samples % 600] = ms;
          samples++;
          if (ms > (worst[2]?.ms ?? 0)) {
            worst.push({ ms, fromAt: previous.at, toAt: at, fromFrame: previous.frame, toFrame: frame, ticks: null });
            worst.sort((a, b) => b.ms - a.ms);
            if (worst.length > 3) worst.pop();
            pendingTicks = true;
          }
        } else if (presented > 1) {
          // The video submitted intermediate frames while JS missed callbacks.
          missedCallbacks += presented - 1;
        }
      }
      status = 'measuring';
      previous = { at, frame, presented: meta.presentedFrames };
    }
    resolveTicks();
    callback = video.requestVideoFrameCallback(observe);
  };

  if (!options.captureAllowed()) status = 'capture-disabled';
  else if (!canvas) status = 'no-canvas';
  else if (!canvas.captureStream || !video.requestVideoFrameCallback) status = 'unsupported';
  else {
    try {
      stream = canvas.captureStream();
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no video track');
      track.addEventListener('ended', onEnded);
      video.addEventListener('error', onError);
      doc.addEventListener('visibilitychange', onVisibility);
      owner.addEventListener('kn-capture-change', onCaptureChange);
      // A tiny in-viewport muted video avoids offscreen playback throttling.
      video.muted = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;height:1px;pointer-events:none';
      video.srcObject = stream;
      doc.body.append(video);
      callback = video.requestVideoFrameCallback(observe);
      void video.play().catch(onError);
    } catch {
      end('capture-failed');
    }
  }

  return {
    stop: () => end('stopped'),
    summary: () => {
      const sorted = [...recent].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      resolveTicks();
      return {
        status,
        visible: !doc.hidden,
        samples,
        missedCallbacks,
        recentSamples: recent.length,
        p95GapMs: p95 === undefined ? null : rounded(p95),
        maxGapMs: worst[0] ? rounded(worst[0].ms) : null,
        lastFrameAgeMs: status === 'measuring' && previous && !doc.hidden ? rounded(now() - previous.at) : null,
        worstGaps: worst.map((gap) => ({
          ...gap,
          ms: rounded(gap.ms),
        })),
      };
    },
  };
}
