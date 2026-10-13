/**
 * matchmaking.ts — the 1v1 searching stage: radar, clock, match-found impact.
 *
 * Quick match no longer drops straight onto the board: the mode drawer hands the
 * seat to this module, which owns one full-viewport clay stage — the two-orb
 * arena (you on the left, the rival still a silhouette on the right), the synapse
 * line and its rings sweeping outward between them, the elapsed clock and the
 * cycling status line.
 *
 * Nothing here talks to a server yet. `source` is the seam a socket plugs into:
 * it takes an `AbortSignal` (plus the current `wide` skill filter) and resolves
 * with the `OpponentData` it found. The built-in `simulatedSearch()` answers after
 * ~4s, so the flow is playable today; a transport that is not wired yet (a
 * rejection that is not our own abort) falls back to that same simulated search
 * instead of leaving the radar spinning.
 *
 * A queue that stays silent for `QUIET_MS` stops promising and asks: the stage
 * offers a widened radius (the same clock, a relaxed filter) and a seat against
 * the bot (`onPractice`), so nobody is left sweeping an empty radar.
 *
 * Contract with the shell: `onMatchFound(opponent)` fires after the 300ms impact
 * animation has locked the rival in — the caller starts the race and the stage
 * fades away behind the board. `onCancel` is the player aborting, which returns
 * them to mode selection. Motion is transform/opacity only; the global
 * reduced-motion block stills the rings, the pulse and the flash.
 */
import { motionReduced, settings } from './settings';
import { profile } from './storage';
import { impact, notify, tgUser } from './telegram';

/* ---------- TIQ: the same reading the ladder prints ---------- */

export type MindTier = 'rookie' | 'tactician' | 'strategist' | 'grandmaster';

export const TIER_NAME: Record<MindTier, string> = {
  rookie: 'Rookie',
  tactician: 'Tactician',
  strategist: 'Strategist',
  grandmaster: 'Grandmaster',
};

/** TIQ bands, matching the ladder's aura colours in `compete.ts`. */
export function tierOf(tiq: number): MindTier {
  if (tiq >= 3000) return 'grandmaster';
  if (tiq >= 2000) return 'strategist';
  if (tiq >= 1000) return 'tactician';
  return 'rookie';
}

/** Your TIQ: a win is worth 120 and every race lands 20 — the ladder's own formula. */
export function myTiq(): number {
  return Math.max(0, profile.stats.wins * 120 + profile.stats.games * 20);
}

export interface OpponentData {
  /** Stable key for the seat, so a real transport can send a real id later. */
  id: string;
  name: string;
  tiq: number;
  tier: MindTier;
  avatarUrl: string | null;
  /** Drawn when the rival carries no photo. */
  initial: string;
}

/** What this attempt is asking for: `wide` is the relaxed skill filter. */
export interface MatchSourceOptions {
  /** True once the player widened the search after a quiet queue. */
  wide: boolean;
}

/** What a transport looks like: resolve with a match, or reject (abort/offline). */
export type MatchSource = (signal: AbortSignal, opts: MatchSourceOptions) => Promise<OpponentData>;

/* ---------- the waiting room: a seeded pool, no server required ---------- */

const RIVALS: ReadonlyArray<{ id: string; name: string; tiq: number }> = [
  { id: 'r-nadia', name: 'Nadia K.', tiq: 1240 },
  { id: 'r-rune', name: 'Rune', tiq: 1875 },
  { id: 'r-ivo', name: 'Ivo Petrov', tiq: 2140 },
  { id: 'r-mira', name: 'Mira', tiq: 2680 },
  { id: 'r-sable', name: 'Sable', tiq: 3150 },
  { id: 'r-kenji', name: 'Kenji', tiq: 980 },
  { id: 'r-lior', name: 'Lior', tiq: 1545 },
  { id: 'r-ada', name: 'Ada W.', tiq: 2360 },
];

const asOpponent = (r: { id: string; name: string; tiq: number }): OpponentData => ({
  id: r.id,
  name: r.name,
  tiq: r.tiq,
  tier: tierOf(r.tiq),
  avatarUrl: null,
  initial: (r.name.charAt(0) || '?').toUpperCase(),
});

/**
 * The closest three minds to your own — a believable queue, never a random blowout.
 * `wide` is the radius the stage asks for once the queue has gone quiet: every
 * rival is fair game, and a ±400 TIQ wobble keeps a widened search from landing on
 * the same nearest-three answer twice.
 */
export function pickRival(mine: number = myTiq(), wide = false): OpponentData {
  if (wide) {
    const pool = RIVALS.map((r) => ({ ...r, tiq: Math.max(0, r.tiq + Math.round((Math.random() - 0.5) * 800)) }));
    return asOpponent(pool[Math.floor(Math.random() * pool.length)]);
  }
  const near = [...RIVALS].sort((a, b) => Math.abs(a.tiq - mine) - Math.abs(b.tiq - mine)).slice(0, 3);
  return asOpponent(near[Math.floor(Math.random() * near.length)]);
}

const aborted = (): Error => {
  const e = new Error('matchmaking aborted');
  e.name = 'AbortError';
  return e;
};

/** A transport that answers after `waitMs`, honouring the stage's abort signal. */
export const simulatedSearch = (waitMs = 4000): MatchSource => (signal, opts) =>
  new Promise<OpponentData>((resolve, reject) => {
    const done = (fn: () => void) => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => done(() => reject(aborted()));
    const timer = window.setTimeout(() => done(() => resolve(pickRival(myTiq(), opts.wide))), waitMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });

/* ---------- the shell's own identity, read once per search ---------- */

const domText = (id: string, fallback: string): string => {
  const t = document.getElementById(id)?.textContent?.trim();
  return t ? t : fallback;
};

interface Face {
  name: string;
  initial: string;
  avatarUrl: string | null;
}

function readFace(fallbackName: string): Face {
  const img = document.getElementById('avatar-img') as HTMLImageElement | null;
  const u = tgUser();
  const name = (domText('p-name', '') || u?.first_name || u?.username || fallbackName).trim();
  const avatarUrl = (img && !img.hidden && img.src ? img.src : null) ?? u?.photo_url ?? null;
  const letter = domText('avatar-t', '') || name.charAt(0) || 'P';
  return { name, initial: letter.slice(0, 1).toUpperCase(), avatarUrl };
}

/* ---------- the triumphant tick (sound + haptic) ---------- */

/** E5 then B5, 90ms apart: a short rising pair, never a jingle. */
const NOTES: ReadonlyArray<readonly [number, number]> = [[659.25, 0], [987.77, 0.09]];

let audio: AudioContext | null = null;

/** Respects the Sound switch; a webview without WebAudio simply gets the haptic. */
function chime(): void {
  if (!settings.sound) return;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio ??= new Ctor();
    const ctx = audio;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [freq, at] of NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = t0 + at;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.13, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.32);
    }
  } catch {
    /* no audio in this webview */
  }
}

/* ---------- controller ---------- */

export interface MatchmakingInit {
  /** How a match arrives. Defaults to the ~4s simulated search. */
  source?: MatchSource;
  /** Fires once the rival is locked in: start the race here. */
  onMatchFound?: (opponent: OpponentData) => void;
  /** The player aborted: return to mode selection here. */
  onCancel?: () => void;
  /** The queue stayed quiet and the player chose the bot instead. */
  onPractice?: () => void;
}

export interface Matchmaking {
  open(): void;
  /** Player-initiated abort: light haptic, then back to mode selection. */
  cancel(): void;
  /** How a real socket hands its match over. Ignores the call unless searching. */
  resolveMatch(opponent: OpponentData): void;
  setSource(source: MatchSource): void;
  setOnMatchFound(cb: (opponent: OpponentData) => void): void;
  readonly isOpen: boolean;
}

/** The cycling lines under the arena; the live region only ever says one thing. */
const STATUS: ReadonlyArray<string> = [
  'Scanning tactical tier...',
  'Matching cognitive tempo...',
  'Expanding search radius...',
];
const STATUS_MS = 2500;
/** The impact animation that locks the rival in. */
const IMPACT_MS = 300;
/** The stage's own fade, which the board slides in behind. */
const EXIT_MS = 240;
/** How long a silent queue waits before the stage offers a way out. */
const QUIET_MS = 12000;
/** A widened search answers sooner: the point of widening is to stop waiting. */
const WIDE_MS = 2500;
const WIDE_AGAIN_MS = 1500;

type Stage = 'idle' | 'searching' | 'found';

export function createMatchmaking(init: MatchmakingInit = {}): Matchmaking {
  const root = document.getElementById('overlay-matchmaking') as HTMLElement | null;
  const you = document.getElementById('mm-you') as HTMLElement | null;
  const rival = document.getElementById('mm-rival') as HTMLElement | null;
  const youImg = document.getElementById('mm-you-img') as HTMLImageElement | null;
  const youT = document.getElementById('mm-you-t') as HTMLElement | null;
  const youName = document.getElementById('mm-you-name') as HTMLElement | null;
  const youTiq = document.getElementById('mm-you-tiq') as HTMLElement | null;
  const rivalImg = document.getElementById('mm-rival-img') as HTMLImageElement | null;
  const rivalScan = document.getElementById('mm-rival-scan') as HTMLElement | null;
  const rivalT = document.getElementById('mm-rival-t') as HTMLElement | null;
  const rivalName = document.getElementById('mm-rival-name') as HTMLElement | null;
  const rivalTiq = document.getElementById('mm-rival-tiq') as HTMLElement | null;
  const statusEl = document.getElementById('mm-status') as HTMLElement | null;
  const elapsedEl = document.getElementById('mm-elapsed') as HTMLElement | null;
  const cancelBtn = document.getElementById('mm-cancel') as HTMLButtonElement | null;
  const liveEl = document.getElementById('mm-live') as HTMLElement | null;
  const fallbackEl = document.getElementById('mm-fallback') as HTMLElement | null;
  const expandBtn = document.getElementById('mm-expand') as HTMLButtonElement | null;
  const practiceBtn = document.getElementById('mm-practice') as HTMLButtonElement | null;

  let source: MatchSource = init.source ?? simulatedSearch();
  let onMatchFound = init.onMatchFound;
  let state: Stage = 'idle';
  let run = 0;
  let started = 0;
  let statusIdx = 0;
  let clockId = 0;
  let statusId = 0;
  let liveId = 0;
  let foundId = 0;
  let hideId = 0;
  let quietId = 0;
  /** How many times the player has widened this search: the second pass is a short re-roll. */
  let widenings = 0;
  let ctrl: AbortController | null = null;

  const stillHere = (id: number): boolean => id === run && state === 'searching';

  /** `mm:ss`, tabular figures in the markup. */
  const clock = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  function stopTimers(): void {
    window.clearInterval(clockId);
    window.clearInterval(statusId);
    window.clearTimeout(liveId);
    window.clearTimeout(quietId);
    clockId = statusId = liveId = quietId = 0;
  }

  /** Back to the silhouette: the stage can be reopened without a stale rival in it. */
  function resetStage(): void {
    rival?.classList.remove('is-locked');
    if (rival) rival.dataset.tier = 'rookie';
    if (rivalScan) rivalScan.hidden = false;
    if (rivalT) rivalT.hidden = true;
    if (rivalImg) {
      rivalImg.hidden = true;
      rivalImg.removeAttribute('src');
    }
    if (rivalName) rivalName.textContent = 'Scanning...';
    if (rivalTiq) rivalTiq.textContent = '—';
    rival?.setAttribute('aria-label', 'Waiting for an opponent');
    if (statusEl) {
      statusEl.classList.remove('swap');
      statusEl.textContent = STATUS[0];
    }
    if (elapsedEl) elapsedEl.textContent = '00:00';
    statusIdx = 0;
    widenings = 0;
    clearQuiet();
    root?.classList.remove('is-found');
  }

  function paintFace(
    img: HTMLImageElement | null,
    initial: HTMLElement | null,
    face: { initial: string; avatarUrl: string | null },
  ): void {
    if (img && face.avatarUrl) {
      img.src = face.avatarUrl;
      img.hidden = false;
      if (initial) initial.hidden = true;
      return;
    }
    if (img) {
      img.hidden = true;
      img.removeAttribute('src');
    }
    if (initial) {
      initial.textContent = face.initial;
      initial.hidden = false;
    }
  }

  function paintYou(): void {
    const face = readFace('You');
    const tiq = myTiq();
    if (you) you.dataset.tier = tierOf(tiq);
    if (youName) youName.textContent = face.name;
    if (youTiq) youTiq.textContent = String(tiq);
    paintFace(youImg, youT, face);
    you?.setAttribute('aria-label', `${face.name}, TIQ ${tiq}, ${TIER_NAME[tierOf(tiq)]}`);
  }

  function paintRival(o: OpponentData): void {
    if (rival) rival.dataset.tier = o.tier;
    if (rivalName) rivalName.textContent = o.name;
    if (rivalTiq) rivalTiq.textContent = String(o.tiq);
    if (rivalScan) rivalScan.hidden = true;
    paintFace(rivalImg, rivalT, o);
    rival?.setAttribute('aria-label', `${o.name}, TIQ ${o.tiq}, ${TIER_NAME[o.tier]}`);
  }

  /** One line of the sweep, with its own fade so two neighbours never cross-fade. */
  function setStatus(text: string): void {
    if (!statusEl) return;
    statusEl.textContent = text;
    if (motionReduced()) return;
    statusEl.classList.remove('swap');
    void statusEl.offsetWidth;          // restarting the fade needs a reflow in between
    statusEl.classList.add('swap');
  }

  function cycleStatus(): void {
    statusIdx = (statusIdx + 1) % STATUS.length;
    setStatus(STATUS[statusIdx]);
  }

  function startCycling(): void {
    stopCycling();
    statusId = window.setInterval(cycleStatus, STATUS_MS);
  }

  function stopCycling(): void {
    window.clearInterval(statusId);
    statusId = 0;
  }

  /**
   * The stage stops promising and asks. A quiet queue is nobody's fault, so both
   * ways out are offered at once: a wider net, or the bot.
   */
  function armQuiet(): void {
    window.clearTimeout(quietId);
    quietId = window.setTimeout(() => {
      if (state !== 'searching') return;
      stopCycling();
      setStatus('Queue is quiet — widen the search?');
      if (fallbackEl) {
        fallbackEl.hidden = false;
        fallbackEl.classList.add('on');
      }
      root?.classList.add('is-slow');
      if (liveEl) {
        liveEl.textContent = 'Search is taking longer than usual. Widen the search, or practice against the bot.';
      }
      notify('warning');
    }, QUIET_MS);
  }

  function clearQuiet(): void {
    window.clearTimeout(quietId);
    quietId = 0;
    fallbackEl?.classList.remove('on');
    if (fallbackEl) fallbackEl.hidden = true;
    root?.classList.remove('is-slow');
  }

  /**
   * Widen the net. The clock keeps running — it is the same search — but the
   * transport is asked for a relaxed radius, and the quiet timer re-arms.
   */
  function widen(): void {
    if (state !== 'searching') return;
    impact('light');
    widenings += 1;
    clearQuiet();
    ctrl?.abort();                       // the abandoned attempt must not answer into this one
    ctrl = new AbortController();
    const id = ++run;
    setStatus(widenings > 1 ? 'Second pass — every mind is fair game...' : 'Expanding search radius...');
    startCycling();
    if (liveEl) liveEl.textContent = 'Search widened — looking beyond your tier';
    const src = init.source ?? simulatedSearch(widenings > 1 ? WIDE_AGAIN_MS : WIDE_MS);
    queue(id, src, init.source ? 1 : 0, true);
    armQuiet();
  }

  /** No queue at all: hand the seat to the bot rather than leave a player waiting. */
  function practice(): void {
    if (state !== 'searching') return;
    impact('medium');
    teardown('Switching to practice');
    hide();
    init.onPractice?.();
  }

  /** The match: gold flash, the rival locked in, a triumphant tick, then the board. */
  function found(o: OpponentData): void {
    if (state !== 'searching') return;
    state = 'found';
    stopTimers();
    clearQuiet();
    paintRival(o);
    root?.classList.add('is-found');
    rival?.classList.add('is-locked');
    if (liveEl) liveEl.textContent = `Opponent found: ${o.name}, TIQ ${o.tiq}`;
    chime();
    impact('heavy');
    notify('success');

    ctrl?.abort();                       // stop caring about the transport we no longer need
    ctrl = null;
    run++;                               // any late answer is ignored now
    window.clearTimeout(foundId);
    /* no motion: the impact is stilled, so hold the locked-in rival a beat longer instead */
    const wait = motionReduced() ? 450 : IMPACT_MS;
    foundId = window.setTimeout(() => {
      state = 'idle';                    // the search is over: Back must not re-enter it
      hide();
      onMatchFound?.({ ...o });
    }, wait);
  }

  function hide(): void {
    window.clearTimeout(hideId);
    root?.classList.remove('open');
    if (motionReduced()) {
      if (root) root.hidden = true;
      return;
    }
    hideId = window.setTimeout(() => {
      if (root) root.hidden = true;
    }, EXIT_MS);
  }

  /** Walk the source, falling back to the local search when no socket answers. */
  function queue(id: number, src: MatchSource, tries: number, wide: boolean): void {
    const signal = ctrl?.signal;
    if (!signal) return;
    src(signal, { wide }).then(
      (o) => {
        if (stillHere(id)) found(o);
      },
      () => {
        if (!stillHere(id) || tries <= 0) return;
        queue(id, simulatedSearch(), tries - 1, wide);
      },
    );
  }

  function open(): void {
    if (!root || state === 'searching' || state === 'found') return;
    state = 'searching';
    window.clearTimeout(foundId);
    window.clearTimeout(hideId);
    resetStage();
    paintYou();
    root.hidden = false;
    void root.offsetWidth;               // lay the stage out at its closed position first
    root.classList.add('open');
    cancelBtn?.focus({ preventScroll: true });

    const id = ++run;
    started = performance.now();
    clockId = window.setInterval(() => {
      if (elapsedEl) elapsedEl.textContent = clock(performance.now() - started);
    }, 500);
    startCycling();
    armQuiet();

    /* announced after the region is live, so a screen reader hears it once */
    if (liveEl) liveEl.textContent = '';
    liveId = window.setTimeout(() => {
      if (liveEl && state === 'searching') liveEl.textContent = 'Searching for opponent';
    }, 120);

    ctrl = new AbortController();
    queue(id, source, init.source ? 1 : 0, false);
  }

  function cancel(): void {
    if (state === 'idle') return;
    impact('light');
    teardown('Search cancelled');
    hide();
    init.onCancel?.();
  }

  function teardown(message: string): void {
    stopTimers();
    window.clearTimeout(foundId);
    ctrl?.abort();
    ctrl = null;
    run++;
    state = 'idle';
    if (liveEl) liveEl.textContent = message;
  }

  cancelBtn?.addEventListener('click', () => cancel());
  expandBtn?.addEventListener('click', () => widen());
  practiceBtn?.addEventListener('click', () => practice());
  /* nothing to hand the seat to? then the queue only offers the wider net */
  if (practiceBtn && !init.onPractice) practiceBtn.hidden = true;

  const api: Matchmaking = {
    open,
    cancel,
    resolveMatch(o) {
      if (state === 'searching') found(o);
    },
    setSource(next) {
      source = next;
    },
    setOnMatchFound(cb) {
      onMatchFound = cb;
    },
    get isOpen() {
      return state !== 'idle';
    },
  };

  return api;
}
