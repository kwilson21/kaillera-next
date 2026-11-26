import { canCommitCheckpoint } from './checkpoint-commit.ts';
import { createActor } from 'xstate';
import { checkpointMachine } from './checkpoint-machine.ts';
import { checkRelayed } from './relay.ts';
import { startEvery } from './poll.ts';
import type { WirePayload } from './wire.ts';
import type { Input } from './owner-proof.ts';
import { CheckpointJournal, digestBytes, digestRecord, neutral, sameInput } from './checkpoint-journal.ts';
import {
  BATCH_SIZE,
  CHECKPOINT_MESSAGE,
  decodeCheckpoint,
  JOURNAL_FRAMES,
  type CheckpointWire,
} from './checkpoint-wire.ts';

const PERIOD = 128;
const MAX_DELAY = 16;
const RECOVERY_POLL_MS = 16;
type Member = Readonly<{ slot: number; sid: string }>;
type Snapshot = {
  frame: number;
  bytes: Uint8Array<ArrayBuffer>;
  hidden: Uint32Array<ArrayBuffer>;
  hle: Uint8Array<ArrayBuffer>;
  fifo: Uint32Array<ArrayBuffer>;
};
type Scope = { match: string; members: readonly Member[]; fingerprint: string; mask: number };
type Run = Readonly<{ id: string; request: number; returning: number; c: number; r: number; anchor: string }>;
export type ReplayFrame = { frame: number; delay: number; inputs: readonly Input[] };
type Port = {
  scope: () => Scope | null;
  rosterConfirmed: () => boolean;
  frame: () => number;
  delay: () => number;
  safe: () => boolean;
  failed: () => number;
  capture: () => Snapshot | null;
  install: (s: Snapshot) => boolean;
  replay: (step: ReplayFrame) => boolean;
  prepare: (r: number, inputs: ReadonlyMap<number, Map<number, Input>>) => boolean;
  first: () => Input;
  resume: (r: number, values: ReadonlyMap<number, Input>, run: Run) => void;
  canReturn: (id: number) => boolean;
  currentRoute: () => boolean;
  send: (msg: WirePayload) => void;
  log: (s: string) => void;
  recovering: () => void;
  unresolved: () => void;
};
type Anchor = { frame: number; seal: string; snapshot: Snapshot };
type Decision = { run: Run; state: string; history: string; epoch: number; first: Input };
type Candidate = { parent: number; votes: Map<number, string>; local?: Anchor };
type InstallReceipt = Readonly<{ state: string; history: string }>;
const agrees = (a: InstallReceipt | undefined, b: InstallReceipt) => a?.state === b.state && a.history === b.history;
const sameRun = (a: Run, b: Run) =>
  a.id === b.id &&
  a.c === b.c &&
  a.r === b.r &&
  a.request === b.request &&
  a.returning === b.returning &&
  a.anchor === b.anchor;
const stateDigest = async (s: Snapshot) => {
  return digestRecord(
    await Promise.all(
      [
        s.bytes,
        s.hle,
        new Uint8Array(s.hidden.buffer, s.hidden.byteOffset, s.hidden.byteLength),
        new Uint8Array(s.fifo.buffer, s.fifo.byteOffset, s.fifo.byteLength),
      ].map(digestBytes),
    ),
  );
};
export class CheckpointRecovery {
  readonly journal: CheckpointJournal;
  readonly slots: number[];
  private readonly actor = createActor(checkpointMachine).start();
  private readonly identity: string;
  private roster = '';
  private epoch = 0;
  private previous: Anchor | null = null;
  private anchor: Anchor | null = null;
  private readonly candidates = new Map<number, Candidate>();
  private lastSample = -1;
  private invalidated = false;
  private baselineFailures: number;
  private run: Run | null = null;
  private chosen: Anchor | null = null;
  private stopped = new Set<number>();
  private ownerRows = new Map<number, Map<number, Input>>();
  private receipts = new Map<number, InstallReceipt>();
  private firstInputs = new Map<number, Input>();
  private cursor = 0;
  private minTag = 0;
  private expires = 0;
  private lastDecisionAsk = 0;
  private lastCommit: Decision | null = null;
  private installedState: Snapshot | null = null;
  private installedSeal = '';
  private closed = false;
  private readonly schedule: typeof startEvery;
  private stopClock: (() => void) | null = null;
  private waitingForDecision = false;
  private readonly port: Port;
  private readonly scope: Scope;
  readonly self: number;
  constructor(port: Port, scope: Scope, self: number, schedule = startEvery) {
    this.port = port;
    this.schedule = schedule;
    this.scope = scope;
    this.self = self;
    this.slots = scope.members.map((m) => m.slot);
    this.journal = new CheckpointJournal(self, this.slots);
    this.identity = JSON.stringify(scope);
    this.baselineFailures = port.failed();
    port.log(`CHECKPOINT-ENABLED slots=${this.slots.join(',')}`);
    void digestRecord(scope).then((h) => {
      this.roster = h;
    });
  }
  get phase() {
    return this.actor.getSnapshot().value;
  }
  get blocksInput() {
    return this.busy && this.phase !== 'approaching';
  }
  get busy() {
    return this.phase !== 'playing';
  }
  get holdsFrame() {
    if (!this.run || !this.busy) return false;
    return (
      this.phase !== 'approaching' || this.port.frame() >= this.run.r || !this.current() || !this.port.currentRoute()
    );
  }
  private cancelClock() {
    const stop = this.stopClock;
    this.stopClock = null;
    stop?.();
  }
  private armClock() {
    if (this.stopClock) return;
    const stop = this.schedule(() => {
      if (this.stopClock !== stop) return;
      try {
        this.service();
      } catch (error) {
        this.port.log(`CHECKPOINT-WAKE-FAILED ${error}`);
        this.fail('checkpoint wake failed');
      }
    }, RECOVERY_POLL_MS);
    this.stopClock = stop;
  }
  close() {
    this.closed = true;
    this.cancelClock();
    this.actor.stop();
    this.candidates.clear();
    this.anchor = null;
    this.previous = null;
  }
  current() {
    const s = this.port.scope();
    return !this.closed && s !== null && JSON.stringify(s) === this.identity;
  }
  invalidate() {
    this.invalidated = true;
  }
  witness(slot: number, sid: string, tag: number, v: Input) {
    if (this.scope.members.some((m) => m.slot === slot && m.sid === sid)) this.journal.witness(slot, tag, v);
  }
  private send(
    op: CheckpointWire['op'],
    fields: Readonly<Record<string, WirePayload>>,
    run: Run | null = null,
    to = this.scope.members,
  ) {
    for (const member of to)
      if (member.slot !== this.self)
        this.port.send({
          type: CHECKPOINT_MESSAGE,
          op,
          match: this.scope.match,
          epoch: this.epoch,
          roster: this.roster,
          targetSid: member.sid,
          ...run,
          ...fields,
        });
  }
  private candidate(frame: number, parent: number) {
    let c = this.candidates.get(frame);
    if (!c) {
      c = { parent, votes: new Map() };
      this.candidates.set(frame, c);
    }
    return c.parent === parent ? c : null;
  }
  sample(frame: number) {
    if (
      this.busy ||
      frame % PERIOD ||
      this.lastSample === frame ||
      !this.current() ||
      this.invalidated ||
      this.port.failed() !== this.baselineFailures ||
      !this.port.safe()
    )
      return;
    const base = this.anchor;
    this.lastSample = frame;
    for (const c of this.candidates.values())
      if (c.local && (!base || c.local.frame === base.frame))
        this.send('vote', { c: c.local.frame, parent: c.parent + 1, seal: c.local.seal });
    if (frame !== 0 && !base) return;
    for (const f of this.candidates.keys()) if (f < frame - PERIOD) this.candidates.delete(f);
    const transcript = this.journal.transcript(base?.frame ?? 0, frame);
    if (!transcript) return;
    const snapshot = this.port.capture();
    if (!snapshot || snapshot.frame !== frame) return;
    const parent = base?.frame ?? -1;
    const c = this.candidate(frame, parent);
    if (!c) return;
    void Promise.all([stateDigest(snapshot), digestRecord(transcript), digestRecord(this.scope)])
      .then(async ([state, inputs, roster]) => {
        const seal = await digestRecord([1, roster, this.epoch, base?.seal ?? '', frame, state, inputs]);
        if (
          this.busy ||
          this.invalidated ||
          !this.current() ||
          this.candidates.get(frame) !== c ||
          this.anchor !== base
        )
          return;
        if (frame === 0) this.port.log(`CHECKPOINT-ROOT seal=${seal}`);
        this.roster = roster;
        c.local = { frame, seal, snapshot };
        c.votes.set(this.self, seal);
        this.send('vote', { c: frame, parent: parent + 1, seal });
        this.acceptAnchor(c);
      })
      .catch(() => {
        this.candidates.delete(frame);
      });
  }
  private acceptAnchor(c: Candidate) {
    if (c.parent !== (this.anchor?.frame ?? -1)) return;
    const a = c.local;
    if (!a || a.frame <= (this.anchor?.frame ?? -1) || !this.slots.every((slot) => c.votes.get(slot) === a.seal))
      return;
    this.previous = this.anchor;
    this.anchor = a;
    this.port.log(`CHECKPOINT-AGREED c=${a.frame} seal=${a.seal}`);
  }
  request(slot: number, request: number) {
    if (
      this.self !== 0 ||
      this.busy ||
      !this.anchor ||
      !this.port.rosterConfirmed() ||
      !this.current() ||
      !this.slots.includes(slot) ||
      !this.roster
    )
      return false;
    const c = this.anchor.frame,
      r = this.port.frame() + 60;
    if (r - c + MAX_DELAY > JOURNAL_FRAMES) return false;
    const run = { id: crypto.randomUUID(), request, returning: slot, c, r, anchor: this.anchor.seal };
    this.begin(run, this.anchor);
    this.send('freeze', {}, run);
    return true;
  }
  private begin(run: Run, anchor: Anchor) {
    this.run = run;
    this.chosen = anchor;
    this.expires = performance.now() + 20000;
    this.stopped.clear();
    this.ownerRows.clear();
    this.receipts.clear();
    this.firstInputs.clear();
    this.waitingForDecision = false;
    this.minTag = Math.max(0, run.c - MAX_DELAY);
    this.cursor = run.c;
    this.actor.send({ type: 'FREEZE' });
    this.armClock();
    this.port.recovering();
    this.port.log(`CHECKPOINT-FREEZE c=${run.c} r=${run.r} request=${run.request}`);
  }
  private fail(reason: string, hostDecision = false) {
    if (!this.run || this.phase === 'unresolved' || this.phase === 'committed') return;
    // After voting to install, only the coordinator can decide to abort.
    if (this.self !== 0 && this.phase === 'installed' && !hostDecision && this.receipts.has(this.self)) {
      if (!this.waitingForDecision) this.send('abort', {}, this.run);
      this.waitingForDecision = true;
      return;
    }
    this.actor.send({ type: 'FAIL' });
    this.cancelClock();
    this.send('abort', {}, this.run);
    this.port.log(`CHECKPOINT-UNRESOLVED ${reason}`);
    this.port.unresolved();
  }
  receive(raw: WirePayload) {
    const m = decodeCheckpoint(raw);
    if (!m || this.closed || m.match !== this.scope.match || m.roster !== this.roster || !this.current()) return;
    if (!raw || typeof raw !== 'object' || !('knFrom' in raw)) return;
    const stamp = checkRelayed({ type: m.type, knFrom: raw.knFrom });
    const member = this.scope.members.find((p) => p.slot === stamp.slot && p.sid === stamp.sid);
    if (
      !stamp.allowed ||
      !stamp.stamped ||
      !member ||
      member.slot === this.self ||
      m.targetSid !== this.scope.members.find((p) => p.slot === this.self)?.sid
    )
      return;
    const from = member.slot;
    if (
      m.op === 'decision' &&
      this.lastCommit &&
      m.epoch === this.lastCommit.epoch &&
      sameRun(m, this.lastCommit.run)
    ) {
      const d = this.lastCommit,
        common = {
          type: CHECKPOINT_MESSAGE,
          match: this.scope.match,
          epoch: d.epoch,
          roster: this.roster,
          targetSid: member.sid,
          ...d.run,
        };
      if (this.self === 0) this.port.send({ ...common, op: 'release', state: d.state, history: d.history });
      this.port.send({ ...common, op: 'ready', value: d.first, state: d.state, history: d.history });
      return;
    }
    if (m.epoch !== this.epoch) return;
    if (this.phase === 'unresolved' && this.self === 0 && m.op === 'decision' && this.run && sameRun(this.run, m)) {
      this.send('abort', {}, this.run, [member]);
      return;
    }
    if (m.op === 'vote') {
      if (
        this.busy ||
        m.c % PERIOD ||
        (m.c < this.port.frame() - PERIOD * 2 && m.c !== this.anchor?.frame && !(m.c === 0 && !this.anchor)) ||
        m.c > this.port.frame() + PERIOD
      )
        return;
      const c = this.candidate(m.c, m.parent - 1);
      if (!c) return;
      const old = c.votes.get(from);
      if (old && old !== m.seal) {
        this.candidates.delete(m.c);
        return;
      }
      c.votes.set(from, m.seal);
      if (!old && c.local) this.send('vote', { c: m.c, parent: m.parent, seal: c.local.seal }, null, [member]);
      this.acceptAnchor(c);
      return;
    }
    if (m.op === 'freeze') {
      if (
        !this.port.rosterConfirmed() ||
        from !== 0 ||
        this.busy ||
        m.r <= m.c ||
        m.r - m.c + MAX_DELAY > JOURNAL_FRAMES ||
        m.r > this.port.frame() + JOURNAL_FRAMES ||
        !this.slots.includes(m.returning)
      )
        return;
      const anchor = [this.anchor, this.previous].find((a) => a?.seal === m.anchor && a.frame === m.c);
      if (!anchor || (this.self === m.returning && !this.port.canReturn(m.request))) return;
      this.begin({ id: m.id, c: m.c, r: m.r, request: m.request, returning: m.returning, anchor: m.anchor }, anchor);
      return;
    }
    if (!this.run || !sameRun(m, this.run) || this.phase === 'unresolved') return;
    if (m.op === 'abort') {
      if (this.self === 0 || from === 0 || this.phase !== 'installed') this.fail('participant aborted', from === 0);
      return;
    }
    if (m.op === 'frozen') {
      this.stopped.add(from);
      return;
    }
    if (m.op === 'journal' && this.phase !== 'committed') {
      if (m.owner !== from) return;
      if (m.start < this.minTag || m.start + m.values.length > m.r) return this.fail('journal bounds');
      m.values.forEach((v, i) => this.add(from, m.start + i, v));
      return;
    }
    if (m.op === 'installed') {
      const old = this.receipts.get(from);
      if (old && !agrees(old, m)) return this.fail('conflicting install receipt');
      this.receipts.set(from, { state: m.state, history: m.history });
      this.maybeCommit();
      return;
    }
    if (m.op === 'release' && from === 0 && this.phase === 'installed' && agrees(this.receipts.get(this.self), m)) {
      this.commit(m.state, m.history);
      return;
    }
    if (m.op === 'decision' && this.phase === 'installed' && from === 0) {
      const local = this.receipts.get(this.self);
      if (local) this.send('installed', local, this.run, [member]);
      return;
    }
    if (m.op === 'ready') {
      if (!agrees(this.receipts.get(this.self), m)) return;
      const old = this.firstInputs.get(from);
      if (old && !sameInput(old, m.value)) return this.fail('conflicting first input');
      this.firstInputs.set(from, m.value);
    }
  }
  private add(slot: number, tag: number, v: Input) {
    let rows = this.ownerRows.get(slot);
    if (!rows) {
      rows = new Map();
      this.ownerRows.set(slot, rows);
    }
    const old = rows.get(tag);
    if (!this.journal.matches(slot, tag, v) || (old && !sameInput(old, v))) return this.fail('owner input conflict');
    rows.set(tag, v);
  }
  private freeze(run: Run) {
    this.actor.send({ type: 'STOP' });
    this.stopped.add(this.self);
    this.send('frozen', {}, run);
    for (let start = this.minTag; start < run.r; start += BATCH_SIZE) {
      const values: Input[] = [];
      for (let t = start; t < Math.min(start + BATCH_SIZE, run.r); t++) {
        const v = this.journal.owner(t);
        if (!v) return this.fail('missing authored tag ' + t);
        this.add(this.self, t, v);
        values.push(v);
      }
      this.send('journal', { owner: this.self, start, values }, run);
    }
  }
  private replayFrame(f: number): ReplayFrame | null {
    const step = this.journal.step(f);
    if (!step || step.delay < 0 || step.delay > MAX_DELAY) return null;
    const tag = f - step.delay,
      values = this.slots.map((s) => (tag < 0 ? neutral : this.ownerRows.get(s)?.get(tag)));
    if (!values.every((v): v is Input => !!v)) return null;
    return { frame: f, delay: step.delay, inputs: values };
  }
  private service() {
    const run = this.run;
    if (!run || this.phase === 'playing') return;
    if (this.phase === 'unresolved') return;
    if (!this.current() || !this.port.currentRoute()) {
      this.fail('membership or route changed');
      return;
    }
    if (
      this.phase !== 'committed' &&
      (this.self === 0 || this.phase !== 'installed') &&
      performance.now() >= this.expires
    ) {
      this.fail('deadline');
      return;
    }
    if (this.phase === 'approaching') {
      const f = this.port.frame();
      if (f < run.r) return;
      if (f !== run.r || !this.port.safe()) {
        this.fail('cannot freeze at planned native boundary');
        return;
      }
      this.freeze(run);
    }
    if (
      this.phase === 'frozen' &&
      this.stopped.size === this.slots.length &&
      this.slots.every((s) => this.ownerRows.get(s)?.size === run.r - this.minTag)
    ) {
      this.actor.send({ type: 'INSTALL' });
      if (!this.chosen || !this.port.install(this.chosen.snapshot)) {
        this.fail('native restore');
        return;
      }
    }
    if (this.phase === 'replaying') {
      const start = performance.now();
      while (this.cursor < run.r && performance.now() - start < 12) {
        const row = this.replayFrame(this.cursor);
        if (!row || !this.port.replay(row)) {
          this.fail('native replay at ' + this.cursor);
          return;
        }
        this.cursor++;
      }
      if (this.cursor === run.r) {
        const prepared = this.port.prepare(run.r, this.ownerRows);
        const state = prepared ? this.port.capture() : null;
        if (!state || state.frame !== run.r) {
          this.fail('native install');
          return;
        }
        this.installedState = state;
        this.actor.send({ type: 'VERIFY' });
        const history = Array.from({ length: run.r - run.c }, (_, i) => this.replayFrame(run.c + i));
        void Promise.all([stateDigest(state), digestRecord([this.port.delay(), history])])
          .then(async ([digest, h]) => {
            const seal = await digestRecord([1, this.roster, this.epoch + 1, run.anchor, run.r, digest, h]);
            if (this.run !== run || this.phase !== 'installed' || !this.current() || !this.port.currentRoute()) return;
            this.installedSeal = seal;
            this.receipts.set(this.self, { state: digest, history: h });
            this.port.log(`CHECKPOINT-INSTALLED c=${run.c} r=${run.r} state=${digest} history=${h}`);
            this.send('installed', { state: digest, history: h }, run);
            this.maybeCommit();
          })
          .catch(() => this.fail('digest failed'));
      }
    }
    if ((this.phase === 'installed' || this.phase === 'committed') && performance.now() - this.lastDecisionAsk > 1000) {
      this.lastDecisionAsk = performance.now();
      this.send('decision', {}, run);
    }
    if (this.phase === 'committed' && this.firstInputs.size === this.slots.length) {
      if (!this.installedState || !this.installedSeal) return;
      this.port.resume(run.r, this.firstInputs, run);
      for (const [slot, v] of this.firstInputs) this.journal.witness(slot, run.r, v);
      this.epoch++;
      this.run = null;
      this.previous = null;
      this.anchor = { frame: run.r, seal: this.installedSeal, snapshot: this.installedState };
      this.chosen = null;
      this.installedState = null;
      this.installedSeal = '';
      this.invalidated = false;
      this.candidates.clear();
      this.ownerRows.clear();
      this.baselineFailures = this.port.failed();
      this.actor.send({ type: 'RUN' });
      this.cancelClock();
      this.port.log(`CHECKPOINT-RELEASE r=${run.r} epoch=${this.epoch}`);
    }
  }
  private maybeCommit() {
    if (this.self !== 0 || this.phase !== 'installed' || this.receipts.size !== this.slots.length || !this.run) return;
    const proof = this.receipts.get(this.self);
    if (!proof) return;
    const current = this.current() && this.port.currentRoute() && performance.now() < this.expires;
    if (
      !canCommitCheckpoint(
        this.self,
        current,
        this.slots.length,
        this.receipts.size,
        Array.from(this.receipts.values()).every((r) => agrees(r, proof)),
      )
    )
      return this.fail('commit scope or install digest mismatch');
    const { state, history } = proof;
    this.commit(state, history);
    this.send('release', { state, history }, this.run);
  }
  private commit(state: string, history: string) {
    if (!this.run || !this.receipts.has(this.self) || !this.current() || !this.port.currentRoute()) return;
    this.actor.send({ type: 'COMMIT' });
    const value = this.port.first();
    this.lastCommit = { run: this.run, state, history, epoch: this.epoch, first: value };
    this.firstInputs.set(this.self, value);
    this.send('ready', { value, state, history }, this.run);
  }
}
