/**
 * The sync log ring: the engines' bounded in-memory log, flushed to the
 * server in deltas (`session-log`) and exported whole for a debug upload.
 *
 * Entries are numbered from 0 in push order. When the ring is full the
 * oldest entry is overwritten, so sequence numbers stay unique and
 * increasing and a reader can tell what it missed. `clear` starts a new
 * epoch, which tells the server the numbering began again.
 */

/** What the engine logs. */
export interface SyncLogEntry {
  /** Milliseconds, as the engine's clock had it. */
  t: number;
  /** The frame the line was logged on. */
  f: number;
  msg: string;
}

/** An entry as the ring holds it. */
export interface NumberedSyncLogEntry extends SyncLogEntry {
  seq: number;
}

export interface SyncLogRing {
  push: (entry: SyncLogEntry) => void;
  /** Every held entry, oldest first, one tab-separated line each. */
  export: () => string;
  /**
   * Entries with `seq > afterSeq`, oldest first, capped at `max` entries and
   * at `maxBytes` estimated JSON bytes, whichever is hit first. At least one
   * entry is returned once any qualify, even if it alone exceeds `maxBytes`,
   * so one oversized line cannot stall the flush cursor.
   */
  entriesAfter: (afterSeq: number, max: number, maxBytes?: number) => NumberedSyncLogEntry[];
  clear: () => void;
  readonly length: number;
  readonly epoch: string;
}

/** A fresh epoch id: unique enough to tell two numberings apart. */
export const genEpoch = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// One flush must stay well under the 4MB Socket.IO max_http_buffer_size on
// its own: the entry count is capped by the caller, but a run of unusually
// long lines could pass the byte budget first. 1MB leaves room for the
// summary, context and audit fields in the same payload.
const ENTRIES_AFTER_DEFAULT_MAX_BYTES = 1024 * 1024;

export function createSyncLogRing(maxSize: number): SyncLogRing {
  const ring: NumberedSyncLogEntry[] = [];
  let head = 0;
  let count = 0;
  let seq = 0;
  let epoch = genEpoch();
  /** Held entries, oldest first. */
  const held = function* (): Generator<NumberedSyncLogEntry> {
    const start = count < maxSize ? 0 : head;
    for (let i = 0; i < count; i++) {
      const e = ring[(start + i) % maxSize];
      if (e !== undefined) yield e;
    }
  };
  return {
    push: (entry) => {
      ring[head] = { seq: seq++, ...entry };
      head = (head + 1) % maxSize;
      if (count < maxSize) count++;
    },
    export: () => {
      const lines: string[] = [];
      for (const e of held()) lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
      return lines.join('\n');
    },
    entriesAfter: (afterSeq, max, maxBytes = ENTRIES_AFTER_DEFAULT_MAX_BYTES) => {
      const entries: NumberedSyncLogEntry[] = [];
      let bytes = 0;
      for (const e of held()) {
        if (e.seq <= afterSeq) continue;
        // Estimate: the message plus ~64 bytes of JSON for seq, t and f.
        const size = (e.msg?.length || 0) + 64;
        if (entries.length > 0 && bytes + size > maxBytes) break;
        entries.push({ seq: e.seq, t: e.t, f: e.f, msg: e.msg });
        bytes += size;
        if (entries.length >= max) break;
      }
      return entries;
    },
    clear: () => {
      head = 0;
      count = 0;
      seq = 0;
      epoch = genEpoch();
    },
    get length() {
      return count;
    },
    get epoch() {
      return epoch;
    },
  };
}
