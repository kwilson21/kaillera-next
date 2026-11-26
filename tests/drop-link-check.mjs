// Evidence for the real-ROM DROP_LINK fixture (tests/rb-mesh.mjs).
// A subsequent ordinary misprediction does not prove the reset kept a
// prediction. Require one of the held walk tags the host actually ran
// before the test closed the connection.
export const heldPredictionAfterReset = (corrections, slot, heldFrom, hostWalkThrough) => {
  if (!Number.isInteger(heldFrom) || !Number.isInteger(hostWalkThrough) || hostWalkThrough < heldFrom + 2) return null;
  const tagFor = new RegExp('\\[C\\] MISPREDICTION slot=' + slot + ' f=(\\d+)\\b');
  return (
    corrections.find((line) => {
      const match = line.match(tagFor);
      return match !== null && Number(match[1]) >= heldFrom && Number(match[1]) <= hostWalkThrough;
    }) ?? null
  );
};

export const reconnectSyncWindow = (lines, from) => {
  let route = null;
  let proofFrame = null;
  let to = null;
  for (const line of lines) {
    if (to === null) {
      // The engine logs this only after validating the request and its scope.
      const proof = line.match(/\tRECONNECT-ANSWER-APPLIED f=(\d+) request=[1-9]\d*$/);
      if (proof) {
        route = 'proof';
        proofFrame = Number(proof[1]);
        continue;
      }
      if (route === null && /\treconnect resync: sent sync-request-full request=\d+$/.test(line)) route = 'legacy';
    }
    const apply = line.match(/\tsync #\d+ applied \(frame (\d+) -> (\d+), next in \d+f\)$/);
    if (!route || !apply) continue;
    const end = Number(apply[2]);
    if (to === null && (route === 'legacy' || Number(apply[1]) === proofFrame)) to = end;
    else if (route === 'legacy' && to !== null && end > to && end <= to + 12) to = end;
  }
  return { from, to, route };
};
