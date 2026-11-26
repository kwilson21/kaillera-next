/**
 * What every page applied, by input tag, read from its sync log; and whether
 * the pages agree on it around a join (tests/rb-mesh.mjs).
 *
 * A page logs what a forward frame applied (NORMAL-INPUT-TR), what a replayed
 * one did ([C] REPLAY-INPUT-TR) and what a caught-up one did
 * (CATCH-UP-INPUT-TR): `L<slot>@<tag>[b,lx,ly]` for its own slot,
 * `R<slot>@<tag>[b,lx,ly]` for the others. A frame run again replaces what was
 * logged for it before: the last line for a tag wins. The C engine's lines
 * are drained into the log before a catch-up starts, so they come before the
 * catch-up's own.
 *
 * specs/late_join_input_agreement.qnt, joinerAppliesTheHostsInputs and
 * pagesAgreeAroundTheJoin: from the frame of the state a joining page loads,
 * every page (the joining one too) applies the same input for every slot on
 * every tag.
 */

/**
 * The input each tag of `slot` ran with on the page whose log is `sync`, as
 * "buttons,lx,ly", in a Map by tag. Also on the Map: `delay` (the page's input
 * delay, from its first forward line) and `superseded(tag, delay)`: the page
 * ran the tag before it loaded a state of the host's from a later frame
 * (`sync frame reset: a → b`, b > tag + delay): right or wrong, that run is no
 * longer where its state comes from, so a difference on it is reported, not
 * failed.
 */
export const appliedForTag = (sync, slot) => {
  const out = new Map();
  const loggedAt = new Map();
  const loads = [];
  const re = new RegExp(
    `\\t(?:NORMAL-INPUT-TR|CATCH-UP-INPUT-TR|\\[C\\] REPLAY-INPUT-TR) f=\\d+ .*?[LR]${slot}@(\\d+)\\[(-?\\d+),(-?\\d+),(-?\\d+)(?:,[A-Z])?\\]|sync frame reset: \\d+ → (\\d+)`,
    'g',
  );
  let at = 0;
  for (const m of sync.matchAll(re)) {
    at++;
    if (m[5] !== undefined) loads.push({ at, frame: Number(m[5]) });
    else {
      out.set(Number(m[1]), `${m[2]},${m[3]},${m[4]}`);
      loggedAt.set(Number(m[1]), at);
    }
  }
  out.superseded = (tag, delay) => loads.some((load) => load.frame > tag + delay && load.at > (loggedAt.get(tag) ?? 0));
  // A forward frame logs NORMAL-INPUT-TR only when an input it applied was
  // not neutral (and every 60th frame): a frame the page ran without a line
  // applied neutral for every slot. Frames a state load jumped over
  // (`sync frame reset: a → b`, b > a) it never ran. A page that joined a
  // running match ran its first frame at the frame of the state it loaded
  // (`late-join loaded at frame n`), which may have logged nothing.
  const forward = [...sync.matchAll(/\tNORMAL-INPUT-TR f=(\d+) apply=(-?\d+) /g)].map((m) => [+m[1], +m[2]]);
  out.delay = forward.length ? forward[0][0] - forward[0][1] : 0;
  if (forward.length === 0) return out;
  const delay = out.delay;
  const jumps = [...sync.matchAll(/sync frame reset: (\d+) → (\d+)/g)]
    .map((m) => [+m[1], +m[2]])
    .filter(([a, b]) => b > a);
  const joinedAt = [...sync.matchAll(/\tlate-join loaded at frame (\d+)/g)].map((m) => +m[1]);
  const firstRun = Math.min(...forward.map(([f]) => f), ...joinedAt);
  const lastRun = Math.max(...forward.map(([f]) => f));
  for (let f = firstRun; f <= lastRun; f++) {
    if (out.has(f - delay) || jumps.some(([a, b]) => f >= a && f < b)) continue;
    out.set(f - delay, '0,0,0');
  }
  return out;
};

/**
 * The frame of the state the joining page loaded (`late-join loaded at frame
 * n`, its first), or null.
 */
export const joinStateFrame = (sync) => {
  const m = sync.match(/\tlate-join loaded at frame (\d+)/);
  return m ? Number(m[1]) : null;
};

/**
 * Whether every page applied the same input for every slot on every tag of
 * [from, to] that all of them ran.
 *
 * @param pages  [{name, sync}], the joining page among them
 * @param slots  the slots to compare (every player's)
 * @param from   the first tag: the joining page's state frame minus the delay
 * @param to     the last tag (clipped to tags every page has finalized: 40
 *               behind the last one each logged)
 */
export const joinInputAgreement = ({ pages, slots, from, to }) => {
  const perSlot = slots.map((slot) => ({
    slot,
    applied: pages.map(({ sync }) => appliedForTag(sync, slot)),
  }));
  const lastTag = Math.min(...perSlot.flatMap(({ applied }) => applied.map((m) => Math.max(-1, ...m.keys())))) - 40;
  const last = Math.min(to, lastTag);
  const differing = [];
  const superseded = [];
  const compared = Object.fromEntries(slots.map((slot) => [slot, 0]));
  for (const { slot, applied } of perSlot) {
    for (let tag = from; tag <= last; tag++) {
      if (!applied.every((m) => m.has(tag))) continue;
      compared[slot]++;
      const values = applied.map((m) => m.get(tag));
      const off = values.map((v, i) => i).filter((i) => values[i] !== values[0]);
      if (off.length === 0) continue;
      const row = {
        slot,
        tag,
        ...Object.fromEntries(pages.map(({ name }, i) => [name, values[i]])),
      };
      // A difference only on pages that ran the tag before a host state
      // replaced their own (the first page is the host, which never loads one).
      if (off.every((i) => applied[i].superseded(tag, applied[i].delay))) superseded.push(row);
      else differing.push(row);
    }
  }
  return {
    tags: [from, last],
    compared,
    differing: differing.slice(0, 40),
    differingCount: differing.length,
    supersededByHostState: superseded.slice(0, 40),
    supersededCount: superseded.length,
  };
};

/** Compare both finalized hashes against the host in the admission window. */
export const joinHashAgreement = ([host, ...guests], firstFrame, frames) =>
  guests.map((guest) => {
    let compared = 0;
    const differing = [];
    for (let frame = firstFrame; frame < firstFrame + frames; frame++) {
      const h = host[frame];
      const g = guest[frame];
      if (!h?.[0] || !h[1] || !g?.[0] || !g[1]) continue;
      compared++;
      if (h[0] !== g[0] || h[1] !== g[1]) differing.push(frame);
    }
    return { compared, differing };
  });
