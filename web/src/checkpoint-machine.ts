import { createMachine } from 'xstate';

export const checkpointMachine = createMachine({
  id: 'checkpointRecovery',
  initial: 'playing',
  states: {
    playing: { on: { FREEZE: () => ({ target: 'approaching' }) } },
    approaching: { on: { STOP: () => ({ target: 'frozen' }), FAIL: () => ({ target: 'unresolved' }) } },
    frozen: { on: { INSTALL: () => ({ target: 'replaying' }), FAIL: () => ({ target: 'unresolved' }) } },
    replaying: { on: { VERIFY: () => ({ target: 'installed' }), FAIL: () => ({ target: 'unresolved' }) } },
    installed: { on: { COMMIT: () => ({ target: 'committed' }), FAIL: () => ({ target: 'unresolved' }) } },
    committed: { on: { RUN: () => ({ target: 'playing' }) } },
    unresolved: {},
  },
});
