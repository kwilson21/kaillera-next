/**
 * netplay-lockstep.js — DEPRECATED COMPAT SHIM
 *
 * The implementation moved to /static/netplay-rollback.js. This file exists
 * only so cached play.html requests from before the rename do not 404.
 *
 * Both window.NetplayRollback and window.NetplayLockstep (alias) are
 * exposed by netplay-rollback.js, so any legacy code that references
 * window.NetplayLockstep keeps working until cached tabs churn out.
 *
 * Remove this file in a follow-up deploy once cached tabs are gone.
 */
console.warn(
  '[netplay] netplay-lockstep.js is deprecated; the engine is now at netplay-rollback.js. ' +
    'window.NetplayLockstep is a temporary alias that will be removed in a future deploy.',
);
