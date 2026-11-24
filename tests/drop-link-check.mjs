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
