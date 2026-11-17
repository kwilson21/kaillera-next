/** Local native ceiling lease: finality is never weakened to obtain a snapshot. */
export type CaptureReport = {
  head: number;
  frame: number;
  finalized: number;
  replay: number;
  pending: number;
  ceiling: number;
};
export type CaptureLease = { cut: number; deadline: number };
export function acquire(report: CaptureReport, minFrame: number, now: number, budget: number): CaptureLease | null {
  if (
    !Number.isInteger(report.head) ||
    report.head < 0 ||
    report.head < minFrame ||
    report.ceiling !== -1 ||
    !Number.isFinite(now) ||
    !Number.isFinite(budget) ||
    budget <= 0
  )
    return null;
  return { cut: report.head, deadline: now + budget };
}
export function poll(
  lease: CaptureLease,
  report: CaptureReport,
  now: number,
  current: boolean,
): 'wait' | 'ready' | 'abort' {
  if (!current || now >= lease.deadline || report.ceiling !== lease.cut || report.head !== lease.cut) return 'abort';
  return report.frame === lease.cut && report.finalized === lease.cut && report.replay === 0 && report.pending < 0
    ? 'ready'
    : 'wait';
}
