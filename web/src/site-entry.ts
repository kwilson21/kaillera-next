/**
 * Entry point of the small bundle for pages that do not load the core
 * (web/static/dist/kn-site.js): the front page and the admin dashboard. It
 * holds what those pages share with the play page and nothing that needs
 * Effect, so it stays a fraction of the core's size: most of it is the
 * feedback form's stylesheet and the About window's text. The play and demo
 * pages get the same modules from kn-core.js.
 */
import { installSite } from './site/index.ts';
import { installSafeStorage } from './site/storage.ts';

installSafeStorage();
installSite();
