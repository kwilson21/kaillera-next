/**
 * The simulated network of tests/rb-two-player.mjs: when each DataChannel
 * message handed to send() reaches the other page.
 *
 * A message goes through three steps, the way it does on a real connection:
 *   1. hold: DELAY_SYNC_ANSWER_MS keeps a message (and, since a channel is
 *      ordered, everything its channel sends after it) back for a while;
 *   2. the link: one per RTCPeerConnection, shared by all of its channels.
 *      It carries `kbps` kilobits a second, one message at a time, the
 *      earliest-sent message first among those not held. A message waits
 *      for the bytes ahead of it on every channel of its connection, so the
 *      inputs on `lockstep` and `rollback-input` queue behind the state
 *      chunks on `sync-state`. kbps 0 is a link with no rate limit;
 *   3. latency: `lat` ms plus up to `jitter` ms, never reordering a channel.
 * Then the message goes to the real send().
 *
 * This file is injected into the page as source text (see rb-two-player.mjs),
 * so createLinkSchedule must not refer to anything outside itself.
 */

/**
 * @param {{kbps?: number, lat?: number, jitter?: number, random?: () => number, starvedMs?: number}} options
 *   starvedMs: a message that waits this long for the link (from when it
 *   could go to when the link has carried it) is starved; each channel label
 *   keeps the merged spans of page time its starved messages waited through.
 */
export function createLinkSchedule({ kbps = 0, lat = 0, jitter = 0, random = Math.random, starvedMs = 2000 } = {}) {
  const bytesPerMs = kbps > 0 ? kbps / 8 : Infinity;
  let seq = 0;
  // maxBacklogBytes: the most bytes ever waiting for their turn on one link.
  const stats = { kbps, messages: 0, bytes: 0, maxBacklogBytes: 0, byLabel: {} };
  const labelStats = (label) =>
    (stats.byLabel[label] ??= { messages: 0, bytes: 0, maxQueueMs: 0, starved: 0, starvedSpans: [] });

  /** A connection's link. */
  const link = () => ({ busyUntil: -Infinity, pending: [], backlog: 0, channels: [] });
  /** A channel on that link. */
  const channel = (theLink, label) => {
    const ch = { link: theLink, label, lastEligibleAt: -Infinity, lastDeliverAt: -Infinity, items: [] };
    theLink.channels.push(ch);
    return ch;
  };

  // Puts on the link every message whose turn has started by `now`. Once a
  // message has started it is carried whole; one that has not started yet
  // may still be overtaken by a message sent later but free to go earlier
  // (a held message). Returns when the next message starts, or Infinity.
  const advance = (l, now) => {
    for (;;) {
      if (!l.pending.length) return Infinity;
      let soonest = Infinity;
      for (const it of l.pending) soonest = Math.min(soonest, it.eligibleAt);
      const start = Math.max(l.busyUntil, soonest);
      if (start > now) return start;
      // pending is in send order: the first one free to go by `start` was sent earliest.
      const at = l.pending.findIndex((it) => it.eligibleAt <= start);
      const [it] = l.pending.splice(at, 1);
      it.carriedAt = start + it.bytes / bytesPerMs;
      l.busyUntil = it.carriedAt;
      l.backlog -= it.bytes;
      const ch = it.ch;
      it.deliverAt = Math.max(it.carriedAt + lat + (jitter ? random() * jitter : 0), ch.lastDeliverAt);
      ch.lastDeliverAt = it.deliverAt;
      const s = labelStats(ch.label);
      const queueMs = it.carriedAt - it.eligibleAt;
      s.maxQueueMs = Math.max(s.maxQueueMs, queueMs);
      if (queueMs >= starvedMs) {
        s.starved++;
        const last = s.starvedSpans.at(-1);
        if (last && it.eligibleAt <= last.to) last.to = Math.max(last.to, it.carriedAt);
        else s.starvedSpans.push({ from: it.eligibleAt, to: it.carriedAt });
      }
    }
  };

  /** A message handed to send() at `now`, held `holdMs` before it may go. */
  const send = (ch, data, bytes, holdMs, now) => {
    const eligibleAt = Math.max(now + holdMs, ch.lastEligibleAt);
    ch.lastEligibleAt = eligibleAt;
    const it = { seq: seq++, ch, data, bytes, eligibleAt, carriedAt: null, deliverAt: null };
    ch.items.push(it);
    ch.link.pending.push(it);
    ch.link.backlog += bytes;
    stats.messages++;
    stats.bytes += bytes;
    stats.maxBacklogBytes = Math.max(stats.maxBacklogBytes, ch.link.backlog);
    const s = labelStats(ch.label);
    s.messages++;
    s.bytes += bytes;
    advance(ch.link, now);
  };

  /** The messages of this channel due at the other end by `now`, in order. */
  const take = (ch, now) => {
    advance(ch.link, now);
    const due = [];
    while (ch.items.length && ch.items[0].deliverAt !== null && ch.items[0].deliverAt <= now) {
      due.push(ch.items.shift().data);
    }
    return due;
  };

  /** Bytes of this channel the link has not finished carrying by `now`. */
  const unsent = (ch, now) =>
    ch.items.reduce((n, it) => n + (it.carriedAt === null || it.carriedAt > now ? it.bytes : 0), 0);
  /** Bytes of this channel not yet delivered (held, on the link, or in flight). */
  const queued = (ch) => ch.items.reduce((n, it) => n + it.bytes, 0);

  /** When anything on this link next changes: a message starts, or one is due. */
  const wakeAt = (l, now) => {
    let at = advance(l, now);
    for (const ch of l.channels)
      if (ch.items.length && ch.items[0].deliverAt !== null) at = Math.min(at, ch.items[0].deliverAt);
    return at;
  };

  return { link, channel, send, take, unsent, queued, wakeAt, stats };
}

/**
 * The frame a page was on at page time `t`, from its sync log (each line:
 * seq, performance.now(), f=frame, text): the frame of the last line at or
 * before `t`, or of the first line when `t` comes before all of them.
 */
export const frameAtTime = (syncLog, t) => {
  let frame = null;
  for (const line of syncLog.split('\n')) {
    const [, time, f] = line.split('\t');
    if (time === undefined || f === undefined) continue;
    const n = Number(f.replace('f=', ''));
    if (!Number.isFinite(n)) continue;
    if (Number(time) > t) return frame ?? n;
    frame = n;
  }
  return frame;
};

/** Spans of page time as spans of that page's frames. */
export const spansInFrames = (syncLog, spans) =>
  spans.map((span) => ({ from: frameAtTime(syncLog, span.from), to: frameAtTime(syncLog, span.to) }));
