/** Recording, input and comparison options for the demo page. */

/** Whose inputs `?record=` captures (`1` is player 1, `p2` player 2); false when the page is not recording. */
export type RecordMode = 'p1' | 'p2' | false;

/** The demo's options, read once as the page loads. */
export type DemoOptions = {
  readonly record: RecordMode;
  /** `?randomP1=1` (or `demoRandomP1`, `p1Random`): player 1 presses random buttons during a match. */
  readonly randomP1InMatch: boolean;
  /** `?autoCompare=0`: a match stays on rollback instead of flipping to lockstep and back. */
  readonly autoCompareDisabled: boolean;
};

/** The options in a query string (`location.search`). */
export const demoOptions = (search: string): DemoOptions => {
  const params = new URLSearchParams(search);
  const record = params.get('record');
  return {
    record: record === '1' ? 'p1' : record === 'p2' ? 'p2' : false,
    randomP1InMatch:
      params.get('randomP1') === '1' || params.get('demoRandomP1') === '1' || params.get('p1Random') === '1',
    autoCompareDisabled: params.get('autoCompare') === '0',
  };
};
