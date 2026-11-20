/** Both baseline five-second deadlines can end the same input hole. The
 * peer-stale scan runs first and makes the later rollback-stall loop skip
 * the slot. Require causal evidence, not an arbitrary phantom log. */
export function resyncOffEvidence({ lines, range, dropped, lastFrame }) {
  const asks = lines.flatMap((line, index) => {
    const m = line.match(/RB-INPUT-ASK f=(\d+) slot=1 frames=(\d+)\.\.(\d+)/);
    return m && range && Number(m[2]) < range[1] && Number(m[3]) >= range[0] ? [{ index, frame: Number(m[1]) }] : [];
  });
  const timeouts = lines.flatMap((line, index) => {
    const rb = line.match(/RB-INPUT-STALL-TIMEOUT f=(\d+) .*slot=1 .*stalledMs=(\d+)/);
    const stale = line.match(/\tf=(\d+)\tPEER-PHANTOM slot=1 lastAdvance=([\d.]+) staleSec=([\d.]+)/);
    const frame = rb ? Number(rb[1]) : stale ? Number(stale[1]) : -1;
    const causal = asks.some((ask) => ask.index < index && ask.frame === frame);
    if (!causal) return [];
    if (rb && Number(rb[2]) >= 5000) return [{ path: 'rollback-input-deadline', frame, line }];
    if (stale && Number(stale[3]) >= 5 && Number(line.split('\t')[1]) - Number(stale[2]) >= 4999.5)
      return [{ path: 'peer-stale-deadline', frame, line }];
    return [];
  });
  const forbidden = lines.filter((line) =>
    /INPUT-ASK-PUSH|INPUT-ASK-OVERDUE .*→ push|escalation push not sent|peer hard-disconnected:|pushed full state|sync sent to slot=/.test(
      line,
    ),
  );
  const timeout = timeouts[0] ?? null;
  const progressFrames = timeout ? lastFrame - timeout.frame : 0;
  return {
    passed: dropped > 0 && !!timeout && progressFrames >= 60 && forbidden.length === 0,
    timeout,
    progressFrames,
    forbidden,
  };
}
