/** A restored engine waits for the room to confirm that every original seat is ready. */
export class MatchReturn {
  readonly matchId: string;
  readonly source: string;
  readonly released: Promise<boolean>;
  private resolve!: (go: boolean) => void;
  private reported = false;
  private finished = false;

  constructor(matchId: string, source: string) {
    this.matchId = matchId;
    this.source = source;
    this.released = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  ready(report: () => void): Promise<boolean> {
    if (!this.finished && !this.reported) {
      this.reported = true;
      report();
    }
    return this.released;
  }

  finish(matchId: string, go: boolean): void {
    if (matchId !== this.matchId || this.finished) return;
    this.finished = true;
    this.resolve(go);
  }
}
