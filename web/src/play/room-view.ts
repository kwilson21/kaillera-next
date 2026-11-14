/**
 * What the room shows about its players and its game: each player slot, the
 * line of spectators, the Start button, and the in-game info panel. Moved
 * from web/static/play.js, which still finds the elements and writes them.
 */

// ── player slots ─────────────────────────────────────────────────────────────

/** A player as the roster lists them, as far as a slot shows. */
export type SlotPlayer = {
  readonly playerName: string;
  readonly romReady?: boolean | undefined;
  readonly inputType?: string | undefined;
  readonly deviceType?: string | undefined;
};

/** An icon with the words a screen reader gets for it. */
export type Badge = { readonly icon: string; readonly label: string };

/** What one slot shows. A null badge is an empty, hidden one. */
export type SlotView = {
  readonly name: string;
  readonly empty: boolean;
  /** The name gets its special styling. */
  readonly flair: boolean;
  /** ROM status text and the class beside `rom-status`, or '' for neither. */
  readonly romText: string;
  readonly romClass: '' | 'ready' | 'not-ready';
  readonly input: Badge | null;
  readonly device: Badge | null;
  /** The "Join" button a spectator can take the slot with. */
  readonly claimHidden: boolean;
};

/** Who is looking, and whether a game is on. */
export type SlotContext = {
  /** This slot's player owns the room. */
  readonly isOwner: boolean;
  readonly gameRunning: boolean;
  /** The viewer is a spectator. */
  readonly viewerSpectates: boolean;
};

const FLAIR_NAME = /\b(a21|agent[- ]?21|atwenty0ne)\b/i;

/** What a slot shows for the player in it, or for nobody. */
export const slotView = (player: SlotPlayer | null, context: SlotContext): SlotView => {
  if (player === null) {
    return {
      name: 'Open',
      empty: true,
      flair: false,
      romText: '',
      romClass: '',
      input: null,
      device: null,
      // A spectator may take an open slot while the room is in the lobby.
      claimHidden: !(context.viewerSpectates && !context.gameRunning),
    };
  }
  const ready = Boolean(player.romReady);
  const gamepad = (player.inputType || 'keyboard') === 'gamepad';
  const mobile = (player.deviceType || 'desktop') === 'mobile';
  return {
    name: player.playerName + (context.isOwner ? ' (host)' : ''),
    empty: false,
    flair: FLAIR_NAME.test(player.playerName),
    // ROM status matters before the game; in a game everyone has one.
    romText: context.gameRunning ? '' : ready ? '✓ ROM' : 'needs ROM',
    romClass: context.gameRunning ? '' : ready ? 'ready' : 'not-ready',
    input: gamepad ? { icon: '🎮', label: 'Gamepad' } : { icon: '⌨️', label: 'Keyboard' },
    device: mobile ? { icon: '📱', label: 'Mobile' } : { icon: '🖥️', label: 'Desktop' },
    claimHidden: true,
  };
};

/** The line naming who is watching, or nothing. */
export const spectatorLine = (names: readonly string[]): string =>
  names.length > 0 ? `Watching: ${names.join(', ')}` : '';

// ── the Start button ─────────────────────────────────────────────────────────

/** What the host's Start button says and whether it can be pressed. */
export type StartButton = { readonly disabled: boolean; readonly label: string };

/**
 * `mode` is the one selected. A streamed game needs a second person and no
 * ROMs but the host's. A rollback game needs every player's ROM, unless the
 * host is sharing theirs.
 */
export const startButton = (
  playerCount: number,
  readyCount: number,
  mode: string,
  romSharing: boolean,
): StartButton => {
  if (playerCount < 1) return { disabled: true, label: 'Start Game' };
  if (mode === 'streaming') {
    return playerCount < 2
      ? { disabled: true, label: 'Start Game (need 2+)' }
      : { disabled: false, label: 'Start Game' };
  }
  if (readyCount < playerCount && !romSharing) {
    return { disabled: true, label: `Waiting for ROMs (${readyCount}/${playerCount})` };
  }
  return { disabled: false, label: 'Start Game' };
};

// ── the in-game info panel ───────────────────────────────────────────────────

/** What the engine reports about the match (`engine.getInfo()`). */
export type EngineInfo = {
  /** 'rollback', 'streaming', or the legacy 'lockstep'. */
  readonly mode: string;
  readonly fps?: number | null | undefined;
  readonly ping?: number | null | undefined;
  readonly frameDelay?: number | undefined;
  readonly playerCount?: number | undefined;
  readonly rollback?: { readonly rollbacks: number; readonly predictions: number } | null | undefined;
  readonly syncEnabled?: boolean | undefined;
  readonly resyncCount?: number | undefined;
  readonly codec?: string | null | undefined;
  readonly resolution?: string | null | undefined;
  readonly peers?: readonly { readonly slot: number; readonly rtt: number | null }[] | null | undefined;
  readonly encodeTime?: number | null | undefined;
  readonly bitrate?: number | null | undefined;
  readonly jitter?: number | null | undefined;
  readonly lossRate?: number | null | undefined;
};

/** The panel's three lines. */
export type InfoPanel = { readonly header: string; readonly stats: string; readonly peers: string };

const milliseconds = (value: number | null | undefined): string =>
  value !== null && value !== undefined ? `${Math.round(value)}ms` : '--';

const rollbackStats = (info: EngineInfo): string[] => [
  // With rollback the delay is hidden by prediction.
  info.rollback ? `Delay: ${info.frameDelay}f (feels 0f)` : `Delay: ${info.frameDelay}f`,
  `Players: ${info.playerCount}`,
  ...(info.rollback ? [`Rollback: ${info.rollback.rollbacks}/${info.rollback.predictions}`] : []),
  ...(info.syncEnabled && (info.resyncCount ?? 0) > 0 ? [`Resyncs: ${info.resyncCount}`] : []),
];

const streamingStats = (info: EngineInfo): string[] => [
  ...(info.codec && info.codec !== '?' ? [info.codec] : []),
  ...(info.resolution && info.resolution !== '?x?' ? [info.resolution] : []),
  `Players: ${info.playerCount}`,
];

const streamingDetail = (info: EngineInfo): string[] => [
  ...(info.encodeTime !== null ? [`Encode: ${info.encodeTime}ms`] : []),
  ...(info.bitrate !== null ? [`BW: ${info.bitrate}Mbps`] : []),
  ...(info.jitter !== null ? [`Jitter: ${info.jitter}ms`] : []),
  ...(info.lossRate && info.lossRate > 0 ? [`Loss: ${info.lossRate}%`] : []),
];

/**
 * The info panel for a running match, or its resting text with no engine.
 * `usesGamepad`: the viewer's own slot has a gamepad.
 */
export const infoPanel = (info: EngineInfo | null, usesGamepad: boolean): InfoPanel => {
  if (info === null) return { header: '', stats: 'FPS: -- | Ping: --', peers: '' };
  // Anything that is not streaming runs the rollback engine ('lockstep' is its old name).
  const streaming = info.mode === 'streaming';
  const stats = [
    `FPS: ${info.fps || 0}`,
    `Ping: ${milliseconds(info.ping)}`,
    ...(streaming ? streamingStats(info) : rollbackStats(info)),
  ];
  const peers = streaming
    ? streamingDetail(info)
    : (info.peers ?? []).map((peer) => `P${peer.slot + 1}: ${milliseconds(peer.rtt)}`);
  return {
    header: `${streaming ? 'Streaming' : 'Rollback'} | ${usesGamepad ? 'Gamepad' : 'Keyboard'}`,
    stats: stats.join(' | '),
    peers: peers.join(' | '),
  };
};
