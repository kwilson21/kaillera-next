import { setupEffect } from '@xstate/effect';
import { Schema } from 'effect';
import { createActor, toPromise } from 'xstate';

// The room can publish its grant before the local engine installs the save
// (specs/room_member_return.qnt, room_saved_seat_fixed).
const Empty = Schema.Struct({});
export const matchReturnMachine = setupEffect({
  schemas: { events: { install: Empty, grant: Empty, restart: Empty, cancel: Empty } },
}).createMachine({
  id: 'matchReturn',
  initial: 'installing',
  on: { cancel: { target: '.cancelled' } },
  states: {
    installing: { on: { install: { target: 'waitingForPlayers' }, grant: { target: 'grantedBeforeInstall' } } },
    waitingForPlayers: { on: { grant: { target: 'playing' }, restart: { target: 'installing' } } },
    grantedBeforeInstall: { on: { install: { target: 'playing' } } },
    playing: { type: 'final' },
    cancelled: { type: 'final' },
  },
});

/** One return epoch shared by the page and its current netplay engine. */
export class MatchReturn {
  readonly matchId: string;
  readonly source: string;
  private readonly report: (ready: boolean) => void;
  private readonly actor = createActor(matchReturnMachine).start();
  readonly released = toPromise(this.actor).then(() => this.playing);

  constructor(matchId: string, source: string, report: (ready: boolean) => void) {
    this.matchId = matchId;
    this.source = source;
    this.report = report;
  }

  get needsInstall(): boolean {
    const state = this.actor.getSnapshot().value;
    return state === 'installing' || state === 'grantedBeforeInstall';
  }

  get playing(): boolean {
    return this.actor.getSnapshot().value === 'playing';
  }

  startEngine(matchId: string): this | null {
    if (matchId !== this.matchId || this.playing) return null;
    this.actor.send({ type: 'restart' });
    return this;
  }

  ready(): Promise<boolean> {
    if (this.needsInstall) {
      this.actor.send({ type: 'install' });
      if (this.actor.getSnapshot().value === 'waitingForPlayers') this.report(true);
    }
    return this.released;
  }

  fail(): boolean {
    if (this.actor.getSnapshot().status === 'done') return false;
    this.actor.send({ type: 'cancel' });
    this.report(false);
    return true;
  }

  finish(matchId: string, go: boolean): void {
    if (matchId === this.matchId) this.actor.send({ type: go ? 'grant' : 'cancel' });
  }
}
