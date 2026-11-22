// Experimental predicate only. The real adapter must supply authenticated
// sender metadata, true native observations, and a current lease. No I/O.
export type Input = readonly [buttons: number, x: number, y: number, cx: number, cy: number];
export type Sample = readonly [inputId: number, input: Input];
export type Generation = Readonly<{ match: string; epoch: number; sid: string; slot: number; gen: number }>;
type Proof = Readonly<{
  owner: Generation;
  token: string;
  frame: number;
  deadline: number;
  missing: ReadonlySet<number>;
  accepted: ReadonlyMap<number, Input>;
}>;
type Open = Readonly<{
  owner: Generation;
  token: string;
  frame: number;
  delay: number;
  cap: number;
  missing: readonly number[];
  now: number;
  ttl: number;
}>;
type Reply = Readonly<{ sender: Generation; token: string; samples: readonly Sample[]; now: number }>;
type Native = Readonly<{
  frame: number;
  pendingRollback: boolean;
  replayDepth: number;
  failedRollbacks: number;
  initialFailures: number;
  confirmedConsumedInputs: boolean;
}>;
const integer = (n: number, lo: number, hi: number): boolean => Number.isSafeInteger(n) && n >= lo && n <= hi;
export const sameOwner = (a: Generation, b: Generation): boolean =>
  a.match === b.match && a.epoch === b.epoch && a.sid === b.sid && a.slot === b.slot && a.gen === b.gen;
const sameInput = (a: Input, b: Input): boolean => a.every((v, i) => v === b[i]);
const validInput = (v: Input): boolean =>
  Array.isArray(v) &&
  v.length === 5 &&
  integer(v[0], -0x80000000, 0x7fffffff) &&
  v.slice(1).every((n) => integer(n, -128, 127));
export function openProof(p: Open): Proof | null {
  if (
    !integer(p.frame, 0, 0x7fffffff) ||
    !integer(p.delay, 1, 12) ||
    !integer(p.cap, 1, 7) ||
    !p.token ||
    !integer(p.owner.slot, 1, 3) ||
    !Number.isFinite(p.now) ||
    !integer(p.ttl, 1, 1_500) ||
    p.missing.length < 1 ||
    p.missing.length > p.cap + 1
  )
    return null;
  const upper = p.frame - p.delay;
  const lower = Math.max(0, upper - p.cap);
  const missing = new Set(p.missing);
  if (missing.size !== p.missing.length || p.missing.some((id) => !integer(id, lower, upper))) return null;
  return {
    owner: { ...p.owner },
    token: p.token,
    frame: p.frame,
    deadline: p.now + p.ttl,
    missing,
    accepted: new Map(),
  };
}
// Return null for a rejected reply; leave the old proof intact. Callers must
// supply *actual* local confirmed RTC observations, not synthetic neutral.
export function acceptReply(
  p: Proof,
  current: Generation,
  r: Reply,
  confirmed: ReadonlyMap<number, Input>,
): Proof | null {
  if (
    !Number.isFinite(r.now) ||
    r.now >= p.deadline ||
    p.token !== r.token ||
    !sameOwner(p.owner, current) ||
    !sameOwner(p.owner, r.sender) ||
    r.samples.length < 1 ||
    r.samples.length > p.missing.size
  )
    return null;
  const next = new Map(p.accepted);
  const seen = new Set<number>();
  for (const [id, v] of r.samples) {
    const known = confirmed.get(id) ?? next.get(id);
    if (seen.has(id) || !p.missing.has(id) || !validInput(v) || (known && !sameInput(known, v))) return null;
    seen.add(id);
    next.set(id, [v[0], v[1], v[2], v[3], v[4]]);
  }
  return { ...p, accepted: next };
}
export function captureAllowed(p: Proof, current: Generation, now: number, native: Native): boolean {
  return (
    Number.isFinite(now) &&
    now < p.deadline &&
    sameOwner(p.owner, current) &&
    p.accepted.size === p.missing.size &&
    native.frame === p.frame &&
    native.confirmedConsumedInputs &&
    !native.pendingRollback &&
    native.replayDepth === 0 &&
    native.failedRollbacks === native.initialFailures
  );
}
