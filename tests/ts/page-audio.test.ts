import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  asksForTap,
  audioRateUnset,
  AUDIO_WORKLET_NAME,
  AUDIO_WORKLET_URL,
  canResume,
  clockKeptUp,
  clockProbeDue,
  isSilence,
  levelWindow,
  logsEmptyFrame,
  logsFedFrame,
  pcmRms,
  pullRing,
  pushPcm,
  resumeAttemptDue,
  ringSizeFor,
  startAudio,
  zombieRecoveryDue,
  type AudioCallbacks,
  type AudioCore,
  type AudioCtx,
  type AudioGlobals,
  type AudioHost,
  type AudioPipeline,
  type AudioRing,
  type AudioSink,
  type AudioStreamDestination,
} from '../../web/src/page/audio.ts';

// The pipeline sits between the rollback engine's tick loop and the speakers,
// so it is held to the script it replaced: both run on the same fake page
// through the same long random sequences of what the engine, play.js and the
// browser do to it, and everything either of them does is written to a tape
// that must come out the same.

// ── the code this replaced, kept as an oracle ────────────────────────────────
// web/static/kn-audio.js as of #166, unchanged.
const OLD_SCRIPT = readFileSync(new URL('./fixtures/kn-audio.old.js', import.meta.url), 'utf8');

// ── typed arrays that say when one is made ───────────────────────────────────
// The feed runs every frame, so what it allocates is part of its behaviour.
const RealInt16Array = Int16Array;
const RealFloat32Array = Float32Array;
let allocations: string[] | null = null;
globalThis.Int16Array = new Proxy(RealInt16Array, {
  construct(target, args, newTarget) {
    const made = Reflect.construct(target, args, newTarget);
    allocations?.push(`alloc Int16Array ${made.length}`);
    return made;
  },
});
globalThis.Float32Array = new Proxy(RealFloat32Array, {
  construct(target, args, newTarget) {
    const made = Reflect.construct(target, args, newTarget);
    allocations?.push(`alloc Float32Array ${made.length}`);
    return made;
  },
});

/** FNV-1a over numbers, to put a buffer's exact contents on the tape in one word. */
const digest = (values: ArrayLike<number>): string => {
  let hash = 2166136261;
  for (let i = 0; i < values.length; i++) hash = Math.imul(hash ^ (values[i] ?? 0), 16777619) >>> 0;
  return hash.toString(16);
};

/** A ring's exact bits. */
const ringDigest = (ring: Float32Array | null | undefined): string =>
  ring ? `${ring.length}:${digest(new Uint32Array(ring.buffer, ring.byteOffset, ring.length))}` : String(ring);

const mulberry = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── the fake page ────────────────────────────────────────────────────────────

interface FakeCtx extends AudioCtx {
  state: string;
  currentTime: number;
}

interface FakeScript {
  onaudioprocess: ((event: { outputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
  connect(destination: AudioSink): void;
  disconnect(): void;
}

interface FakeWorklet {
  onprocessorerror: ((event: { readonly message?: string } | undefined) => void) | null;
}

interface Host extends AudioHost<FakeCtx> {
  KNAudio?: AudioPipeline<FakeCtx>;
  EJS_emulator:
    | { gameManager?: { Module?: AudioCore | undefined } | undefined; audioContext?: { state?: string } | undefined }
    | undefined;
  _kn_gestureAudioDest?: AudioSink | null | undefined;
}

/** How this page is at the start. */
interface Setup {
  readonly slot: number;
  readonly rate: number;
  readonly worklet: boolean;
  readonly startsRunning: boolean;
  readonly toast: boolean;
  readonly dump: 'records' | 'throws' | 'absent';
  readonly al: 'contexts' | 'bare' | 'absent';
  readonly sdl: boolean;
  readonly emulatorAudio: boolean;
  readonly missingExport: boolean;
}

const PTR = 2048;

/** What the page's browser, core and engine are doing; the steps change it. */
interface World {
  now: number;
  frame: number;
  slot: number;
  lastRb: number | null;
  resets: number;
  samples: number;
  hidden: boolean;
  /** How fast a running context's clock runs against the wall clock; 0 is a stalled one. */
  clockFactor: number;
  resumeMode: string;
  suspendMode: string;
  moduleMode: string;
  nodeThrows: boolean;
  heap: Uint8Array;
}

const domError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const page = (setup: Setup) => {
  const tape: string[] = [];
  const names = new WeakMap<WeakKey, string>();
  let made = 0;
  const named = <T extends WeakKey>(kind: string, thing: T): T => {
    names.set(thing, `${kind}${++made}`);
    return thing;
  };
  /** The name a thing was given; a listener gets one the first time it is seen. */
  const nameOf = (thing: WeakKey | null | undefined): string => {
    if (thing === null || thing === undefined) return String(thing);
    const known = names.get(thing);
    if (known !== undefined) return known;
    named('handler', thing);
    return names.get(thing) ?? '';
  };

  const world: World = {
    now: 5000.25,
    frame: 100,
    slot: setup.slot,
    lastRb: null,
    resets: 0,
    samples: 0,
    hidden: false,
    clockFactor: 1,
    resumeMode: 'ok',
    suspendMode: 'ok',
    moduleMode: 'ok',
    nodeThrows: false,
    heap: new Uint8Array(1 << 15),
  };
  const ctxs: FakeCtx[] = [];
  const scripts: FakeScript[] = [];
  const worklets: FakeWorklet[] = [];
  // What the browser has been asked for and has not answered yet: a module load, a suspend, a resume.
  const pending: { resolve: () => void; reject: (reason: Error) => void }[] = [];
  const listeners = new Map<string, (() => void)[]>();

  class Ctx implements FakeCtx {
    state: string;
    currentTime = 0;
    readonly sampleRate: number;
    readonly destination: AudioSink;
    readonly audioWorklet: { addModule(url: string): Promise<void> } | undefined;
    constructor(options?: { sampleRate: number; latencyHint: string }) {
      named('ctx', this);
      tape.push(`new AudioContext ${nameOf(this)} ${JSON.stringify(options)}`);
      this.sampleRate = options?.sampleRate ?? 48000;
      this.state = setup.startsRunning ? 'running' : 'suspended';
      this.destination = named('speakers', { context: this });
      this.audioWorklet = setup.worklet
        ? {
            addModule: (url) => {
              tape.push(`addModule ${nameOf(this)} ${url} (${world.moduleMode})`);
              if (world.moduleMode === 'ok') return Promise.resolve();
              if (world.moduleMode === 'fail') return Promise.reject(new Error('worklet refused'));
              if (world.moduleMode === 'failNull') return Promise.reject(null);
              return new Promise((resolve, reject) => pending.push({ resolve, reject }));
            },
          }
        : undefined;
      ctxs.push(this);
    }
    resume(): Promise<void> {
      tape.push(`resume ${nameOf(this)} (${world.resumeMode})`);
      if (this.state === 'closed') return Promise.reject(domError('InvalidStateError', 'context is closed'));
      if (world.resumeMode === 'fail') return Promise.reject(domError('NotAllowedError', 'no gesture'));
      if (world.resumeMode === 'ok') this.state = 'running';
      if (world.resumeMode === 'defer')
        return new Promise((resolve, reject) =>
          pending.push({
            resolve: () => {
              if (this.state !== 'closed') this.state = 'running';
              resolve();
            },
            reject,
          }),
        );
      if (world.resumeMode === 'late')
        return Promise.resolve().then(() => {
          if (this.state !== 'closed') this.state = 'running';
        });
      return Promise.resolve();
    }
    suspend(): Promise<void> {
      tape.push(`suspend ${nameOf(this)} (${world.suspendMode})`);
      if (world.suspendMode === 'fail') return Promise.reject(domError('InvalidStateError', 'cannot suspend'));
      if (world.suspendMode === 'defer')
        return new Promise((resolve, reject) =>
          pending.push({
            resolve: () => {
              if (this.state !== 'closed') this.state = 'suspended';
              resolve();
            },
            reject,
          }),
        );
      this.state = 'suspended';
      return Promise.resolve();
    }
    close(): Promise<void> {
      tape.push(`close ${nameOf(this)}`);
      this.state = 'closed';
      return Promise.resolve();
    }
    createMediaStreamDestination(): AudioStreamDestination {
      const destination: AudioStreamDestination = named('streamDest', {
        context: this,
        stream: { getAudioTracks: () => [] },
        disconnect: () => {
          tape.push(`disconnect ${nameOf(destination)}`);
        },
      });
      tape.push(`createMediaStreamDestination ${nameOf(this)} -> ${nameOf(destination)}`);
      return destination;
    }
    createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): FakeScript {
      const node: FakeScript = named('script', {
        onaudioprocess: null,
        connect: (destination: AudioSink) => {
          tape.push(`connect ${nameOf(node)} -> ${nameOf(destination)}`);
        },
        disconnect: () => {
          tape.push(`disconnect ${nameOf(node)}`);
        },
      });
      tape.push(
        `createScriptProcessor ${nameOf(this)} ${bufferSize} ${inputChannels} ${outputChannels} -> ${nameOf(node)}`,
      );
      scripts.push(node);
      return node;
    }
  }

  class Worklet implements FakeWorklet {
    onprocessorerror: ((event: { readonly message?: string } | undefined) => void) | null = null;
    readonly port = {
      postMessage: (message: Int16Array, transfer: ArrayBuffer[]): void => {
        tape.push(
          `post ${nameOf(this)} int16=${message instanceof RealInt16Array} offset=${message.byteOffset} ` +
            `values=${message.length}:${digest(message)} transfer=${transfer.length} ` +
            `transfersItsOwnBuffer=${transfer[0] === message.buffer} apartFromTheHeap=${message.buffer !== world.heap.buffer}`,
        );
      },
    };
    constructor(context: FakeCtx | null, name: string, options: { processorOptions: { sampleRate: number } }) {
      named('worklet', this);
      tape.push(`new AudioWorkletNode ${nameOf(this)} ${nameOf(context)} ${name} ${JSON.stringify(options)}`);
      if (!context) throw new TypeError('parameter 1 is not of type BaseAudioContext');
      if (world.nodeThrows) throw new Error('node refused');
      worklets.push(this);
    }
    connect(destination: AudioSink): void {
      tape.push(`connect ${nameOf(this)} -> ${nameOf(destination)}`);
    }
    disconnect(): void {
      tape.push(`disconnect ${nameOf(this)}`);
    }
  }

  const core = (kind: 'full' | 'noSamples'): AudioCore => ({
    get HEAPU8() {
      return world.heap;
    },
    _kn_get_audio_ptr: () => {
      tape.push('core ptr');
      return PTR;
    },
    _kn_get_audio_rate: () => {
      tape.push('core rate');
      return setup.rate;
    },
    _kn_get_audio_samples:
      kind === 'noSamples'
        ? undefined
        : () => {
            tape.push('core samples');
            return world.samples;
          },
    _kn_reset_audio: setup.missingExport
      ? undefined
      : () => {
          tape.push('core reset');
        },
    AL: setup.al === 'absent' ? undefined : setup.al === 'bare' ? {} : { contexts: { first: 1, second: 2 } },
    SDL2: setup.sdl ? { audioContext: { state: 'running' } } : undefined,
  });

  const emulator = () => ({
    gameManager: { Module: core('full') },
    audioContext: setup.emulatorAudio ? { state: 'suspended' } : undefined,
  });

  const host: Host = {
    AudioContext: Ctx,
    AudioWorkletNode: Worklet,
    performance: {
      now: () => {
        tape.push('now');
        return world.now;
      },
    },
    document: {
      get hidden() {
        return world.hidden;
      },
      addEventListener: (type, listener, capture) => {
        tape.push(`listen ${type} ${capture} ${nameOf(listener)}`);
        const held = listeners.get(type) ?? [];
        if (!held.includes(listener)) held.push(listener);
        listeners.set(type, held);
      },
      removeEventListener: (type, listener, capture) => {
        tape.push(`unlisten ${type} ${capture} ${nameOf(listener)}`);
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((held) => held !== listener),
        );
      },
    },
    EJS_emulator: emulator(),
    knShowToast: setup.toast
      ? (message, type) => {
          tape.push(`toast ${type} ${message}`);
        }
      : undefined,
    _knDumpAudioState:
      setup.dump === 'absent'
        ? undefined
        : (label) => {
            tape.push(`dump ${label}`);
            if (setup.dump === 'throws') throw new Error('dump failed');
          },
    _kn_audioRingWrite: 0,
    _kn_audioRingRead: 0,
    _kn_audioRingCount: 0,
  };
  // A page has none of the ring's numbers until the fallback is set up.
  Reflect.deleteProperty(host, '_kn_audioRingWrite');
  Reflect.deleteProperty(host, '_kn_audioRingRead');
  Reflect.deleteProperty(host, '_kn_audioRingCount');

  const callbacks = (tag: string): Required<AudioCallbacks> => ({
    log: (message) => {
      tape.push(`log${tag} ${message}`);
    },
    getFrame: () => {
      tape.push(`getFrame${tag}`);
      return world.frame;
    },
    getSlot: () => {
      tape.push(`getSlot${tag}`);
      return world.slot;
    },
    getLastRbFrame: () => {
      tape.push(`getLastRbFrame${tag}`);
      return world.lastRb;
    },
    getResetAudioCalls: () => {
      tape.push(`getResetAudioCalls${tag}`);
      return world.resets;
    },
    knEvent: (name, message, detail) => {
      tape.push(
        `event${tag} ${name} | ${message} | ${JSON.stringify(detail, (_key, value) => (value === undefined ? '<undefined>' : value))}`,
      );
    },
  });

  return {
    tape,
    host,
    world,
    ctxs,
    scripts,
    worklets,
    pending,
    listeners,
    nameOf,
    core,
    emulator,
    callbacks,
    Ctx,
  };
};

type Page = ReturnType<typeof page>;

// ── what happens to a page ───────────────────────────────────────────────────

type Step =
  | { readonly op: 'init'; readonly callbacks: 'all' | 'none' | 'logOnly' | 'second' }
  | {
      readonly op: 'frames';
      readonly count: number;
      readonly seed: number;
      readonly emptyOneIn: number;
      readonly size: number;
    }
  | { readonly op: 'wait'; readonly ms: number }
  | { readonly op: 'state'; readonly value: string }
  | { readonly op: 'ensure'; readonly reason: string | undefined }
  | { readonly op: 'gesture'; readonly type: string }
  | { readonly op: 'block'; readonly length: number }
  | { readonly op: 'processorError'; readonly message: string | undefined; readonly event: boolean }
  | { readonly op: 'cleanup' }
  | { readonly op: 'hidden'; readonly value: boolean }
  | { readonly op: 'rollback'; readonly known: boolean }
  | { readonly op: 'core'; readonly kind: 'gone' | 'back' | 'noSamples' | 'grown' | 'noEmulator' }
  | {
      readonly op: 'browser';
      readonly resume: string;
      readonly suspend: string;
      readonly module: string;
      readonly nodeThrows: boolean;
      readonly clockFactor: number;
    }
  | { readonly op: 'settle'; readonly ok: boolean }
  | {
      readonly op: 'preload';
      readonly state: string;
      readonly gestureDest: 'same' | 'other' | 'none';
      readonly oscillator: 'stops' | 'throws' | 'none';
    }
  | { readonly op: 'audioElement' }
  | { readonly op: 'assign'; readonly key: 'ready' | 'ctx' | 'destNode' | 'feed' };

/** Write `frames` stereo samples of a pattern only this seed gives into the core's buffer. */
const writePcm = (p: Page, frames: number, seed: number): void => {
  const pcm = new RealInt16Array(p.world.heap.buffer, PTR, frames * 2);
  let value = (seed * 2654435761) >>> 0;
  for (let i = 0; i < pcm.length; i++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    pcm[i] = (value >>> 16) - 32768;
  }
};

const apply = (step: Step, p: Page, api: AudioPipeline<FakeCtx>): void => {
  const { tape, world, host } = p;
  switch (step.op) {
    case 'init': {
      const given =
        step.callbacks === 'all'
          ? p.callbacks('')
          : step.callbacks === 'second'
            ? p.callbacks('#2')
            : step.callbacks === 'logOnly'
              ? { log: p.callbacks('#3').log }
              : {};
      api.init(given).then(
        () => tape.push('init settled'),
        (reason) => tape.push(`init rejected ${reason}`),
      );
      return;
    }
    case 'frames': {
      const random = mulberry(step.seed);
      for (let i = 0; i < step.count; i++) {
        world.frame++;
        world.now += 16.7;
        for (const ctx of p.ctxs) if (ctx.state === 'running') ctx.currentTime += 0.0167 * world.clockFactor;
        const empty = step.emptyOneIn > 0 && Math.floor(random() * step.emptyOneIn) === 0;
        world.samples = empty ? (random() < 0.5 ? 0 : -1) : 1 + Math.floor(random() * step.size);
        if (world.samples > 0) writePcm(p, world.samples, step.seed + i);
        try {
          api.feed();
        } catch (thrown) {
          tape.push(`feed threw ${thrown}`);
        }
      }
      return;
    }
    case 'wait':
      world.now += step.ms;
      for (const ctx of p.ctxs) if (ctx.state === 'running') ctx.currentTime += (step.ms / 1000) * world.clockFactor;
      return;
    case 'state':
      for (const ctx of p.ctxs) if (ctx.state !== 'closed') ctx.state = step.value;
      return;
    case 'ensure':
      tape.push(`ensureRunning -> ${step.reason === undefined ? api.ensureRunning() : api.ensureRunning(step.reason)}`);
      return;
    case 'gesture':
      // A copy: a listener may take itself off the list.
      for (const listener of (p.listeners.get(step.type) ?? []).slice()) listener();
      return;
    case 'block': {
      const node = p.scripts.at(-1);
      if (!node?.onaudioprocess) return;
      const left = new RealFloat32Array(step.length).fill(9);
      const right = new RealFloat32Array(step.length).fill(9);
      try {
        node.onaudioprocess({
          outputBuffer: {
            getChannelData: (channel) => {
              tape.push(`getChannelData ${channel}`);
              return channel === 0 ? left : right;
            },
          },
        });
      } catch (thrown) {
        tape.push(`block threw ${thrown}`);
      }
      tape.push(`block L=${ringDigest(left)} R=${ringDigest(right)} [${left.slice(0, 4).join(' ')}]`);
      return;
    }
    case 'processorError': {
      const node = p.worklets.at(-1);
      if (!node?.onprocessorerror) return;
      node.onprocessorerror(step.event ? (step.message === undefined ? {} : { message: step.message }) : undefined);
      return;
    }
    case 'cleanup':
      api.cleanup();
      return;
    case 'hidden':
      world.hidden = step.value;
      return;
    case 'rollback':
      world.lastRb = step.known ? world.frame - 3 : null;
      world.resets++;
      return;
    case 'core':
      if (step.kind === 'noEmulator') host.EJS_emulator = undefined;
      else if (step.kind === 'gone') host.EJS_emulator = { gameManager: {} };
      else if (step.kind === 'back') host.EJS_emulator = p.emulator();
      else if (step.kind === 'noSamples') host.EJS_emulator = { gameManager: { Module: p.core('noSamples') } };
      else {
        const grown = new Uint8Array(world.heap.length);
        grown.set(world.heap);
        world.heap = grown;
      }
      return;
    case 'browser':
      world.resumeMode = step.resume;
      world.suspendMode = step.suspend;
      world.moduleMode = step.module;
      world.nodeThrows = step.nodeThrows;
      world.clockFactor = step.clockFactor;
      return;
    case 'settle': {
      const waiting = p.pending.shift();
      if (!waiting) return;
      if (step.ok) waiting.resolve();
      else waiting.reject(domError('AbortError', 'the browser gave up'));
      return;
    }
    case 'preload': {
      const made = new p.Ctx();
      made.state = step.state;
      made.currentTime = 12.345;
      host._kn_preloadedAudioCtx = made;
      const other = step.gestureDest === 'other' ? new p.Ctx() : made;
      host._kn_gestureAudioDest = step.gestureDest === 'none' ? null : other.createMediaStreamDestination();
      host._kn_keepAliveOsc =
        step.oscillator === 'none'
          ? null
          : {
              stop: () => {
                tape.push('oscillator stop');
                if (step.oscillator === 'throws') throw new Error('already stopped');
              },
            };
      return;
    }
    case 'audioElement':
      host._kn_audioEl = {
        pause: () => {
          tape.push('audio element pause');
        },
        srcObject: {},
      };
      return;
    case 'assign':
      // Another script writing over a property: methods take the write, the
      // three read-only values refuse it.
      tape.push(`assign ${step.key} -> ${Reflect.set(api, step.key, step.key === 'feed' ? api.feed : null)}`);
      return;
  }
};

/** Everything another script can read, after a step. */
const visible = (p: Page, api: AudioPipeline<FakeCtx>): string => {
  const { host, nameOf } = p;
  const held = [...p.listeners].map(([type, list]) => `${type}:${list.map((l) => nameOf(l)).join('+')}`).join(' ');
  return (
    `= ready=${api.ready} ctx=${nameOf(api.ctx)}/${api.ctx?.state}/${api.ctx?.currentTime} dest=${nameOf(api.destNode)} ` +
    `ring=${ringDigest(host._kn_audioRing)} write=${host._kn_audioRingWrite} read=${host._kn_audioRingRead} ` +
    `count=${host._kn_audioRingCount} preloaded=${'_kn_preloadedAudioCtx' in host}/${nameOf(host._kn_preloadedAudioCtx)} ` +
    `oscillator=${host._kn_keepAliveOsc === null ? 'null' : typeof host._kn_keepAliveOsc} ` +
    `script=${nameOf(host._kn_scriptProcessor)} element=${host._kn_audioEl === null ? 'null' : typeof host._kn_audioEl} ` +
    `listeners=[${held}] keys=${Object.keys(api).join(',')}`
  );
};

// The old script, word for word, as the body of a function whose parameters
// are the globals it reads. (Run as a script in a context of its own, every
// `window.` in its per-sample loops goes through the context's global lookup,
// which is many times slower.)
const runOldScript: (
  window: Host,
  document: Host['document'],
  performance: Host['performance'],
  AudioContext: Host['AudioContext'],
  AudioWorkletNode: Host['AudioWorkletNode'],
) => void = vm.runInThisContext(
  `(function (window, document, performance, AudioContext, AudioWorkletNode) {\n${OLD_SCRIPT}\n})`,
  { filename: 'kn-audio.old.js' },
);

const startOld = (host: Host): AudioPipeline<FakeCtx> => {
  runOldScript(host, host.document, host.performance, host.AudioContext, host.AudioWorkletNode);
  assert.ok(host.KNAudio, 'the old script did not define window.KNAudio');
  return host.KNAudio;
};

const startNew = (host: Host): AudioPipeline<FakeCtx> => startAudio(host);

/** Run one version through a scenario and return its tape. */
const play = async (
  start: (host: Host) => AudioPipeline<FakeCtx>,
  setup: Setup,
  steps: readonly Step[],
): Promise<string[]> => {
  const p = page(setup);
  allocations = p.tape;
  try {
    const api = start(p.host);
    p.tape.push(visible(p, api));
    for (const step of steps) {
      p.tape.push(`# ${JSON.stringify(step)}`);
      apply(step, p, api);
      await flush();
      p.tape.push(visible(p, api));
    }
  } finally {
    allocations = null;
  }
  return p.tape;
};

const pick = <T>(random: () => number, options: readonly T[]): T => options[Math.floor(random() * options.length)]!;

const randomSetup = (random: () => number): Setup => ({
  slot: pick(random, [0, 0, 1, 2]),
  rate: pick(random, [33600, 33600, 44100, 32000, 300, 0, -1, Number.NaN]),
  worklet: random() < 0.6,
  startsRunning: random() < 0.6,
  toast: random() < 0.85,
  dump: pick(random, ['records', 'records', 'throws', 'absent']),
  al: pick(random, ['contexts', 'bare', 'absent']),
  sdl: random() < 0.5,
  emulatorAudio: random() < 0.5,
  missingExport: random() < 0.04,
});

const randomStep = (random: () => number): Step => {
  const roll = random();
  if (roll < 0.3)
    return {
      op: 'frames',
      count: pick(random, [1, 1, 2, 3, 5, 8, 30, 61, 130]),
      seed: Math.floor(random() * 1e6),
      emptyOneIn: pick(random, [0, 0, 0, 4, 1]),
      size: pick(random, [1, 2, 100, 101, 560, 735, 1200]),
    };
  if (roll < 0.33)
    return {
      op: 'frames',
      count: pick(random, [310, 620, 1210]),
      seed: Math.floor(random() * 1e6),
      emptyOneIn: pick(random, [0, 1, 1, 400]),
      size: pick(random, [3, 560]),
    };
  if (roll < 0.4) return { op: 'init', callbacks: pick(random, ['all', 'all', 'all', 'none', 'logOnly', 'second']) };
  if (roll < 0.47) return { op: 'wait', ms: pick(random, [1, 400, 999, 1000, 1001, 1999, 2000, 2001, 5000]) };
  if (roll < 0.54) return { op: 'state', value: pick(random, ['running', 'running', 'suspended', 'interrupted']) };
  if (roll < 0.61) return { op: 'ensure', reason: pick(random, [undefined, 'visibility-return', 'init', 'manual']) };
  if (roll < 0.67) return { op: 'gesture', type: pick(random, ['click', 'keydown', 'pointerdown', 'touchstart']) };
  if (roll < 0.73) return { op: 'block', length: pick(random, [1, 16, 128, 2048, 4096]) };
  if (roll < 0.75)
    return { op: 'processorError', message: pick(random, [undefined, '', 'boom']), event: random() < 0.8 };
  if (roll < 0.79) return { op: 'cleanup' };
  if (roll < 0.81) return { op: 'hidden', value: random() < 0.5 };
  if (roll < 0.85) return { op: 'rollback', known: random() < 0.7 };
  if (roll < 0.88)
    return { op: 'core', kind: pick(random, ['gone', 'back', 'back', 'noSamples', 'grown', 'noEmulator']) };
  if (roll < 0.93)
    return {
      op: 'browser',
      resume: pick(random, ['ok', 'ok', 'stay', 'fail', 'late', 'defer']),
      suspend: pick(random, ['ok', 'ok', 'fail', 'defer']),
      module: pick(random, ['ok', 'ok', 'fail', 'failNull', 'defer']),
      nodeThrows: random() < 0.15,
      clockFactor: pick(random, [1, 1, 0, 0, 0.49, 0.5, 0.9]),
    };
  if (roll < 0.97) return { op: 'settle', ok: random() < 0.7 };
  if (roll < 0.985)
    return {
      op: 'preload',
      state: pick(random, ['running', 'suspended', 'closed']),
      gestureDest: pick(random, ['same', 'other', 'none']),
      oscillator: pick(random, ['stops', 'throws', 'none']),
    };
  if (roll < 0.99) return { op: 'audioElement' };
  return { op: 'assign', key: pick(random, ['ready', 'ctx', 'destNode', 'feed']) };
};

/** A page, and what happens to it. */
interface Scenario {
  readonly setup: Setup;
  readonly steps: readonly Step[];
}

/** A random scenario. Most start the way a match does. */
const scenario = (seed: number): Scenario => {
  const random = mulberry(seed);
  const setup = randomSetup(random);
  const steps: Step[] = [];
  if (random() < 0.3) steps.push(randomStep(random));
  if (random() < 0.25)
    steps.push({
      op: 'preload',
      state: pick(random, ['running', 'suspended', 'closed']),
      gestureDest: pick(random, ['same', 'other', 'none']),
      oscillator: pick(random, ['stops', 'throws', 'none']),
    });
  if (random() < 0.9) steps.push({ op: 'init', callbacks: 'all' });
  const length = 20 + Math.floor(random() * 120);
  for (let i = 0; i < length; i++) steps.push(randomStep(random));
  steps.push(
    { op: 'cleanup' },
    { op: 'frames', count: 2, seed: 1, emptyOneIn: 0, size: 10 },
    { op: 'block', length: 4 },
  );
  return { setup, steps };
};

const SCENARIOS = 400;

const stalledFrames: Step = { op: 'frames', count: 130, seed: 5, emptyOneIn: 0, size: 560 };
/**
 * An iPhone whose audio session was interrupted and does not come back by
 * itself: the context says `running` with a clock that stands still, three
 * suspend/resume cycles do not help, the player is asked to tap, and the tap
 * resumes it.
 */
const STALLED_UNTIL_TAPPED: Scenario = {
  setup: {
    slot: 1,
    rate: 33600,
    worklet: true,
    startsRunning: true,
    toast: true,
    dump: 'records',
    al: 'contexts',
    sdl: true,
    emulatorAudio: true,
    missingExport: false,
  },
  steps: [
    { op: 'init', callbacks: 'all' },
    { op: 'frames', count: 70, seed: 4, emptyOneIn: 0, size: 560 },
    { op: 'browser', resume: 'ok', suspend: 'ok', module: 'ok', nodeThrows: false, clockFactor: 0 },
    stalledFrames,
    stalledFrames,
    { op: 'browser', resume: 'stay', suspend: 'ok', module: 'ok', nodeThrows: false, clockFactor: 0 },
    stalledFrames,
    { op: 'browser', resume: 'ok', suspend: 'ok', module: 'ok', nodeThrows: false, clockFactor: 1 },
    { op: 'gesture', type: 'touchstart' },
    stalledFrames,
    stalledFrames,
    { op: 'cleanup' },
  ],
};

test('every scenario leaves the same tape as the old script: calls, messages, logs, allocations, state', async () => {
  const reached = new Map<string, number>();
  // Each of these is a path the scenarios must have walked, in the old script's own words.
  const landmarks = [
    'post worklet',
    'alloc Int16Array',
    'log audio using AudioWorklet',
    'log audio using ScriptProcessorNode fallback (ring=',
    'log audio using ScriptProcessorNode fallback via <audio> element',
    'log gesture audio destination belongs to a different AudioContext',
    'log AudioWorklet failed, using fallback: worklet refused',
    'log AudioWorklet failed, using fallback: node refused',
    'log AudioWorklet failed, using fallback: the browser gave up',
    'log audio init failed: TypeError',
    'log audio capture exports not found',
    'log audio rate not set yet, defaulting to 33600',
    'log reusing host gesture-created AudioContext',
    'log reusing gesture-created AudioContext',
    'log preloaded AudioContext resume failed',
    'log audio-empty f=',
    'log audio-silent: 300 consecutive frames',
    'log audio-feed #1 ',
    'log audio-feed #600 ',
    'log audio-zombie f=',
    'log audio-zombie recovered',
    'log audio-zombie recovery #1: state=',
    'log audio-zombie recovery #3',
    // cleanup() while the browser still owed an answer: the context is gone when it comes.
    'failed: TypeError: Cannot read properties of null',
    'log audio resume failed: TypeError: Cannot read properties of null',
    'log audio resume failed: AbortError',
    ') -> none',
    'failed: InvalidStateError',
    'toast warn Audio interrupted — tap anywhere to restart sound',
    'toast warn Audio blocked — click anywhere to enable sound',
    'log audio resumed via gesture (zombie',
    'log audio resumed via gesture (feed',
    'log audio resume failed: NotAllowedError: no gesture',
    'log audio resume attempt (feed) -> running',
    'log audio resume attempt (visibility-return) -> ',
    'log audio resume attempt failed (',
    'log audio context state: suspended — waiting for gesture to resume (init)',
    'log audio context state: interrupted — waiting for gesture to resume',
    'log AUDIO-ERROR: ',
    'log AudioWorklet processor error: boom',
    'log AudioWorklet processor error: AudioWorklet processor error',
    'log#2 ',
    'log#3 ',
    'event audio-fail | AudioWorklet failed',
    'event audio-fail | AudioContext resume failed',
    'event audio-fail | audio-zombie ctx clock stalled',
    'event audio-recovered',
    'dump first-audio-empty',
    'block threw TypeError',
    'createMediaStreamDestination',
    'oscillator stop',
    'audio element pause',
    'unlisten touchstart true',
    'assign ready -> false',
    'assign feed -> true',
    'ensureRunning -> true',
    'ensureRunning -> false',
  ];
  for (let seed = 0; seed <= SCENARIOS; seed++) {
    const { setup, steps } = seed === 0 ? STALLED_UNTIL_TAPPED : scenario(seed);
    const oldTape = await play(startOld, setup, steps);
    const newTape = await play(startNew, setup, steps);
    const length = Math.max(oldTape.length, newTape.length);
    for (let i = 0; i < length; i++) {
      if (oldTape[i] === newTape[i]) continue;
      const step = oldTape
        .slice(0, i + 1)
        .filter((line) => line.startsWith('# '))
        .at(-1);
      assert.fail(
        `seed ${seed}, tape line ${i}, during ${step}\n  old: ${oldTape[i]}\n  new: ${newTape[i]}\n` +
          `  before: ${oldTape.slice(Math.max(0, i - 4), i).join('\n          ')}`,
      );
    }
    for (const line of oldTape)
      for (const mark of landmarks) if (line.includes(mark)) reached.set(mark, (reached.get(mark) ?? 0) + 1);
  }
  const missed = landmarks.filter((mark) => !reached.has(mark));
  assert.deepEqual(missed, [], 'the scenarios never reached these paths');
});

test('the object other scripts hold has the old one’s properties, each as writable as it was', () => {
  const setup = randomSetup(mulberry(7));
  const describe = (api: AudioPipeline<FakeCtx>) =>
    Object.entries(Object.getOwnPropertyDescriptors(api)).map(([key, d]) => ({
      key,
      enumerable: d.enumerable,
      configurable: d.configurable,
      writable: d.writable,
      value: typeof d.value,
      arity: typeof d.value === 'function' ? d.value.length : null,
      get: typeof d.get,
      set: typeof d.set,
    }));
  const oldApi = startOld(page(setup).host);
  const newApi = startNew(page(setup).host);
  assert.deepEqual(describe(newApi), describe(oldApi));
  assert.deepEqual(Object.keys(newApi), ['init', 'feed', 'ensureRunning', 'cleanup', 'destNode', 'ready', 'ctx']);
  assert.equal(Object.isFrozen(newApi), Object.isFrozen(oldApi));
  assert.equal(Object.isExtensible(newApi), Object.isExtensible(oldApi));
  assert.deepEqual([newApi.ready, newApi.ctx, newApi.destNode], [false, null, null]);
});

test('a frame goes to the worklet as its own copy of the core’s int16 samples, transferred', async () => {
  const p = page({
    ...randomSetup(mulberry(3)),
    worklet: true,
    startsRunning: true,
    rate: 33600,
    missingExport: false,
  });
  const posted: { message: Int16Array; transfer: ArrayBuffer[] }[] = [];
  const api = startNew(p.host);
  await api.init(p.callbacks(''));
  const node = p.host.KNAudio ?? api;
  assert.equal(node.ready, true);
  const worklet = p.worklets.at(-1);
  assert.ok(worklet instanceof Object && 'port' in worklet);
  // SAFETY: the fake page's worklet; its port is replaced to keep the message itself.
  (worklet as { port: { postMessage: (message: Int16Array, transfer: ArrayBuffer[]) => void } }).port.postMessage = (
    message,
    transfer,
  ) => {
    posted.push({ message, transfer });
  };
  p.world.samples = 560;
  writePcm(p, 560, 42);
  const expected = Array.from(new RealInt16Array(p.world.heap.buffer, PTR, 1120));
  api.feed();
  assert.equal(posted.length, 1);
  const sent = posted[0]!;
  assert.deepEqual(Array.from(sent.message), expected);
  assert.equal(sent.message.byteOffset, 0);
  assert.equal(sent.message.buffer.byteLength, 2240);
  assert.deepEqual(sent.transfer, [sent.message.buffer]);
  assert.notEqual(sent.message.buffer, p.world.heap.buffer);
  assert.ok(p.tape.includes(`addModule ctx1 ${AUDIO_WORKLET_URL} (ok)`));
  assert.ok(
    p.tape.includes(
      `new AudioWorkletNode worklet3 ctx1 ${AUDIO_WORKLET_NAME} {"numberOfInputs":0,"numberOfOutputs":1,"outputChannelCount":[2],"processorOptions":{"sampleRate":33600}}`,
    ),
    p.tape.join('\n'),
  );
  assert.ok(p.tape.includes('new AudioContext ctx1 {"sampleRate":33600,"latencyHint":"interactive"}'));
});

// The fallback ring as kn-audio.js kept it (#166), restated: the write in
// feed() and the read in the ScriptProcessorNode's onaudioprocess.
const oldPush = (window: AudioRing, pcm: Int16Array, n: number): void => {
  const ring = window._kn_audioRing;
  if (ring) {
    const rSize = ring.length;
    for (let i = 0; i < n; i++) {
      if (window._kn_audioRingCount + 2 > rSize) {
        window._kn_audioRingRead = (window._kn_audioRingRead + 2) % rSize;
        window._kn_audioRingCount = Math.max(0, window._kn_audioRingCount - 2);
      }
      ring[window._kn_audioRingWrite] = pcm[i * 2]! / 32768.0;
      ring[(window._kn_audioRingWrite + 1) % rSize] = pcm[i * 2 + 1]! / 32768.0;
      window._kn_audioRingWrite = (window._kn_audioRingWrite + 2) % rSize;
      window._kn_audioRingCount += 2;
    }
    if (window._kn_audioRingCount > rSize) window._kn_audioRingCount = rSize;
  }
};
const oldPull = (window: AudioRing, outL: Float32Array, outR: Float32Array): void => {
  const ring = window._kn_audioRing!;
  const rSize = ring.length;
  for (let si = 0; si < outL.length; si++) {
    if (window._kn_audioRingCount >= 2) {
      outL[si] = ring[window._kn_audioRingRead]!;
      outR[si] = ring[(window._kn_audioRingRead + 1) % rSize]!;
      window._kn_audioRingRead = (window._kn_audioRingRead + 2) % rSize;
      window._kn_audioRingCount -= 2;
    } else {
      outL[si] = 0;
      outR[si] = 0;
    }
  }
};

test('the fallback ring takes and gives the same samples as the old one, through overflow and underrun', () => {
  const random = mulberry(99);
  for (const size of [2, 4, 60, 6720]) {
    const ringOf = (): AudioRing => ({
      _kn_audioRing: new RealFloat32Array(size),
      _kn_audioRingWrite: 0,
      _kn_audioRingRead: 0,
      _kn_audioRingCount: 0,
    });
    const oldRing = ringOf();
    const newRing = ringOf();
    for (let round = 0; round < 400; round++) {
      if (random() < 0.55) {
        const frames = Math.floor(random() * (size + 3));
        const pcm = new RealInt16Array(frames * 2).map(() => Math.floor(random() * 65536) - 32768);
        oldPush(oldRing, pcm, frames);
        pushPcm(newRing, pcm, frames);
      } else {
        const length = Math.floor(random() * (size + 3));
        const outs = [0, 1, 2, 3].map(() => new RealFloat32Array(length).fill(7));
        oldPull(oldRing, outs[0]!, outs[1]!);
        pullRing(newRing, outs[2]!, outs[3]!);
        assert.deepEqual(outs[2], outs[0]);
        assert.deepEqual(outs[3], outs[1]);
      }
      assert.deepEqual(newRing, oldRing);
    }
  }
});

test('the ring holds int16 over 32768, drops the oldest pair when full, and plays silence when dry', () => {
  const ring: AudioRing = {
    _kn_audioRing: new RealFloat32Array(4),
    _kn_audioRingWrite: 0,
    _kn_audioRingRead: 0,
    _kn_audioRingCount: 0,
  };
  pushPcm(ring, RealInt16Array.from([-32768, 32767, 16384, -16384, 1, -1]), 3);
  // Three pairs into room for two: the first pair is gone, the reader starts at the second.
  assert.deepEqual(Array.from(ring._kn_audioRing ?? []), [1 / 32768, -1 / 32768, 0.5, -0.5]);
  assert.deepEqual([ring._kn_audioRingWrite, ring._kn_audioRingRead, ring._kn_audioRingCount], [2, 2, 4]);
  const left = new RealFloat32Array(3).fill(9);
  const right = new RealFloat32Array(3).fill(9);
  pullRing(ring, left, right);
  assert.deepEqual(Array.from(left), [0.5, 1 / 32768, 0]);
  assert.deepEqual(Array.from(right), [-0.5, -1 / 32768, 0]);
  assert.equal(ring._kn_audioRingCount, 0);
  // Without a ring a frame is dropped and a block throws, as in the old script.
  ring._kn_audioRing = null;
  pushPcm(ring, RealInt16Array.from([1, 2]), 1);
  assert.equal(ring._kn_audioRingCount, 0);
  assert.throws(() => pullRing(ring, left, right), TypeError);
});

test('each decision answers as the old script’s expression did', () => {
  const numbers = [Number.NaN, -1, 0, 0.4, 0.5, 0.99, 1, 1.01, 2, 29, 30, 31, 299, 300, 301, 599, 600, 601, 1200];
  for (const n of numbers) {
    assert.equal(logsEmptyFrame(n), n <= 30);
    assert.equal(isSilence(n), n === 300);
    assert.equal(logsFedFrame(n), n === 1 || n % 600 === 0);
    assert.equal(levelWindow(n), Math.min(n * 2, 200));
    assert.equal(asksForTap(n), n >= 3);
    assert.equal(clockProbeDue(n), !(n < 1.0));
    for (const m of numbers) assert.equal(clockKeptUp(n, m), n >= m * 0.5);
  }
  const times = [0, 1, 999, 1000, 1000.5, 1001, 1999, 2000, 2001, 5000.25, Number.NaN];
  for (const now of times)
    for (const last of times) {
      assert.equal(resumeAttemptDue(now, last), now - last > 1000);
      assert.equal(zombieRecoveryDue(now, last), !(now - last < 2000));
    }
  for (const rate of [Number.NaN, -1, 0, 1, 300, 32000, 33600, 44100, 48000]) {
    assert.equal(audioRateUnset(rate), !rate || rate <= 0);
    assert.equal(ringSizeFor(rate), Math.ceil(rate * 0.1) * 2);
  }
  assert.equal(ringSizeFor(33600), 6720);
  for (const state of ['running', 'closed', 'suspended', 'interrupted', ''])
    assert.equal(canResume(state), !(state === 'running' || state === 'closed'));
  const pcm = RealInt16Array.from([3, -4, 3, -4]);
  assert.equal(pcmRms(pcm), Math.sqrt(12.5));
  assert.equal(pcmRms(new RealInt16Array(200)), 0);
});

test('a real window satisfies the host the pipeline asks for', () => {
  const accepts = (host: AudioHost<AudioContext>): AudioHost<AudioContext> => host;
  const check = (win: Window & typeof globalThis & AudioGlobals<AudioContext>): AudioHost<AudioContext> => accepts(win);
  assert.equal(typeof check, 'function');
});
