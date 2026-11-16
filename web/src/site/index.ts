/**
 * What every page gets as `window.KNSite`, whichever bundle it loads: the
 * front page takes it from kn-site.js (site-entry.ts), the play and demo
 * pages from kn-core.js (index.ts). Each function is started by a small
 * caller of the same name in web/static.
 */
import { startVersionGuard } from './version-guard.ts';
import { startFeedback } from './feedback.ts';
import { startVersion } from './version.ts';

export const KNSite = {
  startFeedback,
  startVersion,
  startVersionGuard,
};

declare global {
  interface Window {
    KNSite?: typeof KNSite;
  }
}

/** Put the site functions on the page, where the callers in web/static read them. */
export const installSite = (): void => {
  window.KNSite = KNSite;
};
