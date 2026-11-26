import type { NumberedSyncLogEntry } from './sync-log-ring.ts';

type SequencedEntry = Pick<NumberedSyncLogEntry, 'seq'>;
type ExitOmissions = { logEntries: number; auditEntries: number };
type LogPayload = {
  entries: readonly SequencedEntry[];
  audit?: { epoch: string; entries: readonly SequencedEntry[] };
  summary?: { duration_sec?: number; omittedOnExit?: ExitOmissions };
};

type KeepalivePhase = 'hidden' | 'exit';
const pending = new Set<KeepalivePhase>();

// Both engines share a document's keepalive budget.
export async function sendSessionLogKeepalive(phase: KeepalivePhase, send: () => Promise<Response>) {
  if (pending.has(phase)) return;
  pending.add(phase);
  try {
    return await send();
  } finally {
    pending.delete(phase);
  }
}

const encoder = new TextEncoder();
const sizeOf = (value: LogPayload | SequencedEntry) => encoder.encode(JSON.stringify(value)).length;

function fit(records: readonly SequencedEntry[], budget: number, newest: boolean) {
  let count = 0;
  let used = 0;
  while (count < records.length) {
    const size = sizeOf(records[newest ? records.length - count - 1 : count]!) + 1;
    if (used + size > budget) break;
    used += size;
    count++;
  }
  return { used, entries: newest ? records.slice(records.length - count) : records.slice(0, count) };
}

/**
 * A live page can resubmit a prefix after an ack. A closing document can
 * only start one request, so it sends the newest pending diagnostics.
 * Leave space for the hidden-page prefix within the shared keepalive limit.
 */
export function sessionLogKeepaliveBody(payload: LogPayload, phase: KeepalivePhase): string | null {
  const newest = phase === 'exit';
  const audit = payload.audit?.entries ?? [];
  const empty: LogPayload = { ...payload, entries: [] };
  if (payload.audit) empty.audit = { ...payload.audit, entries: [] };
  const omission = (logs: number, audit: number) => ({ logEntries: logs, auditEntries: audit });
  const budget = (newest ? 56 : 4) * 1024;
  // Reserve the largest possible omission counts when measuring the envelope.
  const envelope = newest
    ? { ...empty, summary: { ...payload.summary, omittedOnExit: omission(payload.entries.length, audit.length) } }
    : empty;
  const available = budget - sizeOf(envelope);
  if (available < 0) return null;

  const reserved = Math.floor(available / 4);
  const entries = fit(payload.entries, available - fit(audit, reserved, newest).used, newest);
  const audits = fit(audit, available - entries.used, newest);
  const batch: LogPayload = { ...payload, entries: entries.entries };
  if (payload.audit) batch.audit = { ...payload.audit, entries: audits.entries };
  if (newest) {
    batch.summary = {
      ...payload.summary,
      omittedOnExit: omission(payload.entries.length - entries.entries.length, audit.length - audits.entries.length),
    };
  }
  return JSON.stringify(batch);
}
