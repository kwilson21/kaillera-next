/**
 * The play page's small menus: the invite menu beside the room code, sharing
 * or copying a link, and the toolbar's More menu. Moved from
 * web/static/play.js.
 */
import { showToast } from './notices.ts';

// ── sharing a link ───────────────────────────────────────────────────────────

/** An invite link and the words that go with it. */
export type ShareLink = {
  readonly url: string;
  /** Names the link in the "copied" toast: "Play link copied!". */
  readonly label: string;
  /** The title a phone's share sheet shows. */
  readonly title: string;
};

/** The two links a room has. */
export const inviteLinks = (playUrl: string, watchUrl: string) => ({
  play: { url: playUrl, label: 'Play link', title: 'Join my game on Kaillera Next' },
  watch: { url: watchUrl, label: 'Watch link', title: 'Watch my game on Kaillera Next' },
});

/** A phone with a share sheet shares; everything else copies. */
export const canNativeShare = (mobile: boolean): boolean => mobile && typeof navigator.share === 'function';

/**
 * Whether a failed share is worth telling the player about. Closing the
 * share sheet (AbortError) and a share with no user gesture
 * (NotAllowedError) are not failures to them.
 */
export const shareFailureIsWorthTelling = (errorName: string): boolean =>
  errorName !== 'AbortError' && errorName !== 'NotAllowedError';

/** Copy text, falling back to a hidden textarea where the clipboard API is not available. */
export const copyToClipboard = async (text: string, label: string): Promise<void> => {
  if (window.isSecureContext && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied!`);
      return;
    } catch {
      /* fall through to the textarea */
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  // The only copy there is on an insecure origin (plain-http LAN play).
  document.execCommand('copy');
  area.remove();
  showToast(`${label} copied!`);
};

/** Open the share sheet on a phone that has one; otherwise copy the link. */
export const shareOrCopy = async (link: ShareLink, mobile: boolean): Promise<void> => {
  if (!canNativeShare(mobile)) {
    await copyToClipboard(link.url, link.label);
    return;
  }
  try {
    await navigator.share({ title: link.title, url: link.url });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (shareFailureIsWorthTelling(name)) showToast('Share failed');
  }
};

// ── the invite menu beside the room code ─────────────────────────────────────

const INVITE_MENU_ID = 'kn-invite-dropdown';

/**
 * Open the Play / Watch invite menu under the copy-link button, or close it
 * if it is open. It is placed by hand on the body because the overlay it
 * belongs to clips its overflow.
 */
export const toggleInviteMenu = (playUrl: string, watchUrl: string, mobile: boolean): void => {
  const existing = document.getElementById(INVITE_MENU_ID);
  if (existing) {
    existing.remove();
    return;
  }
  const button = document.getElementById('copy-link');
  if (!button) return;
  const rect = button.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.id = INVITE_MENU_ID;
  Object.assign(menu.style, {
    position: 'fixed',
    top: `${rect.bottom + 6}px`,
    right: `${window.innerWidth - rect.right}px`,
    background: '#1a1a2e',
    border: '1px solid #2a2a40',
    borderRadius: '8px',
    padding: '4px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: '140px',
    zIndex: '99999',
  });

  const option = (text: string, link: ShareLink) => {
    const item = document.createElement('button');
    item.textContent = text;
    item.className = 'share-option';
    item.addEventListener('click', () => {
      void shareOrCopy(link, mobile);
      menu.remove();
    });
    return item;
  };
  const links = inviteLinks(playUrl, watchUrl);
  menu.append(option('Play', links.play), option('Watch', links.watch));
  document.body.appendChild(menu);

  // Close on a click outside. Registered on the next task, so the click that
  // opened the menu does not close it.
  setTimeout(() => {
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && (menu.contains(target) || target === button)) return;
      menu.remove();
      document.removeEventListener('click', close);
    };
    document.addEventListener('click', close);
  }, 0);
};

// ── the toolbar's More menu ──────────────────────────────────────────────────

/** Space between the More button and its menu, and between the menu and the screen edge. */
const MENU_GAP = 6;
const SCREEN_EDGE = 8;
const MENU_MIN_HEIGHT = 160;

type Box = { readonly top: number; readonly right: number };
type Size = { readonly width: number; readonly height: number };

/** The tallest the More menu may be: the room above the button, but never tiny. */
export const moreMenuMaxHeight = (button: Box): number =>
  Math.max(MENU_MIN_HEIGHT, button.top - SCREEN_EDGE - MENU_GAP);

/**
 * Where the More menu goes: above the button, right edges aligned, kept on
 * screen. On a screen too narrow for it, the right-hand limit wins.
 */
export const moreMenuPlacement = (button: Box, menu: Size, viewportWidth: number) => ({
  left: Math.min(viewportWidth - menu.width - SCREEN_EDGE, Math.max(SCREEN_EDGE, button.right - menu.width)),
  top: Math.max(SCREEN_EDGE, button.top - menu.height - MENU_GAP),
});

const isPopoverOpen = (el: HTMLElement): boolean => {
  try {
    return el.matches(':popover-open');
  } catch {
    // A browser without popovers does not know the selector.
    return false;
  }
};

/** Put the menu in the top layer where the browser can, so nothing covers it. */
const showInTopLayer = (menu: HTMLElement): boolean => {
  if (typeof menu.showPopover !== 'function') return false;
  menu.setAttribute('popover', 'manual');
  try {
    if (!isPopoverOpen(menu)) menu.showPopover();
    return true;
  } catch {
    menu.removeAttribute('popover');
    return false;
  }
};

const leaveTopLayer = (menu: HTMLElement): void => {
  try {
    if (typeof menu.hidePopover === 'function' && isPopoverOpen(menu)) menu.hidePopover();
  } catch {
    // Best-effort only; the z-index fallback still covers older engines.
  }
  menu.removeAttribute('popover');
};

const placeMoreMenu = (menu: HTMLElement, button: HTMLElement | null): void => {
  if (!button) return;
  const rect = button.getBoundingClientRect();
  menu.style.maxHeight = `${moreMenuMaxHeight(rect)}px`;
  menu.style.overflowY = 'auto';
  const placed = moreMenuPlacement(rect, menu.getBoundingClientRect(), window.innerWidth);
  menu.style.left = `${placed.left}px`;
  menu.style.top = `${placed.top}px`;
};

/** Close the More menu and put it back where it lives in the toolbar. */
export const closeMoreMenu = (): void => {
  const menu = document.getElementById('more-dropdown');
  const button = document.getElementById('toolbar-more');
  if (menu) {
    leaveTopLayer(menu);
    menu.classList.add('hidden');
    menu.classList.remove('floating');
    menu.removeAttribute('style');
    const home = document.getElementById('more-wrapper');
    if (home && menu.parentElement !== home) home.appendChild(menu);
  }
  if (button) {
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
  }
};

/** Open the More menu above its button, or close it if it is open. */
export const toggleMoreMenu = (): void => {
  const menu = document.getElementById('more-dropdown');
  const button = document.getElementById('toolbar-more');
  if (!menu) return;
  if (!menu.classList.contains('hidden') || isPopoverOpen(menu)) {
    closeMoreMenu();
    return;
  }
  if (button) {
    // Out of the toolbar, which would clip it.
    document.body.appendChild(menu);
    menu.classList.add('floating');
  }
  menu.classList.remove('hidden');
  const topLayer = showInTopLayer(menu);
  placeMoreMenu(menu, button);
  if (topLayer) {
    // The top layer lays out a frame later; place again once it has.
    requestAnimationFrame(() => {
      if (!menu.classList.contains('hidden')) placeMoreMenu(menu, button);
    });
  }
  if (button) {
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
  }
};
