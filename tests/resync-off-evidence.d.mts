export interface ResyncOffEvidenceInput {
  lines: readonly string[];
  range: readonly number[] | null;
  dropped: number;
  lastFrame: number;
}
export interface ResyncOffEvidence {
  passed: boolean;
  timeout: {
    path: 'rollback-input-deadline' | 'peer-stale-deadline';
    frame: number;
    line: string;
  } | null;
  progressFrames: number;
  forbidden: string[];
}
export function resyncOffEvidence(input: ResyncOffEvidenceInput): ResyncOffEvidence;
