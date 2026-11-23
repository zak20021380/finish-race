/**
 * music.ts — the ambient bed: one looping track behind the arena, and the one switch that owns it.
 *
 * It is deliberately a separate voice from `sound.ts`/`audio.ts`. Those two share the app's
 * AudioContext and every gameplay SFX; this module owns nothing but `<audio>`, so the Music switch
 * in Settings can silence the bed without touching a step, a blast or a fanfare, and the Sound
 * switch never silences the bed. The two switches are independent by construction, not by a flag
 * both engines read.
 *
 * BOOT NEVER WAITS FOR IT. `bgm.mp3` is ~2.8 MB, so it must never ride the first frame: the URL
 * is a plain `new URL(..., import.meta.url)` so Vite emits it as its own static asset (never
 * inlined into JS), and the element is only built by `warmUpBgm()` — 1.8 s after the first screen
 * has mounted, or on the player's first tap, whichever lands first. From there `preload = 'auto'`
 * and a single `load()` pull the track into the media cache while the player is still on Home, so
 * the board's first `play()` is served from memory instead of a cold socket. The warm-up is volume
 * 0, never a `play()`, and always off the critical path.
 *
 * MOBILE WEBVIEWS NEED A GESTURE. Telegram's WebView (and iOS Safari) refuses to start audio
 * outside a trusted interaction, so the first pointerdown/touchstart/keydown is the unlock. Every
 * `play()` is wrapped so a muted or restricted client never logs an unhandled rejection — it just
 * stays quiet until the next gesture offers another chance.
 *
 * THE FADES ARE TIMERS, NOT FRAMES. A 500 ms ramp up and a 250 ms ramp down are driven by one
 * interval each, cleared the instant the ramp lands (or is replaced), so nothing here touches
 * `requestAnimationFrame`, the render loop or the 60 fps budget. One element, one timer handle,
 * no nodes, nothing to collect: flipping the switch a thousand times cannot leak.
 *
 * THE BED IS A MATCH VOICE, NEVER A MENU ONE. Nothing here plays outside a live board: Home,
 * Ranks, the Shop, VIP, Squads, Friends, the lobby and every other screen between matches are
 * silent even with the Music switch on, because `inMatch` is part of `shouldPlay()` and it starts
 * `false` on boot. `setMusicInMatch(true)` is the only door in and it is opened by the board itself
 * (the reveal onto the playable race, or a rematch dealt in place); `setMusicInMatch(false)` closes
 * it on every exit. The switch, the gesture unlock and the lifecycle still work exactly as before —
 * a tap on Home pre-blesses the element for the WebView, it just does not start anything.
 *
 * THE SETTLEMENT OWNS ITS OWN VOICE. When the result capsule opens the bed steps aside — a 220 ms
 * duck, then a pause — so `01-victory-fan.ogg` or `defeat.m4a` is heard alone. It stays parked for
 * as long as that capsule is up: no gesture, focus, visibility change or settings toggle can lift
 * it, because the state is part of `shouldPlay()` rather than a listener's private business.
 * `setMusicMatchOver(false)` is the only door back, and the player's own exit — Play again, a
 * rematch, the menu, a new race — is what opens it.
 *
 * EVERY RACE OPENS AT 0:00. The bed is one long loop, and a paused element remembers where it
 * stopped: without a rewind, quitting at 1:40 would open the next race at 1:40. So the cursor is
 * parked at the top wherever a match is left — the fade-out in `stopBed()`, the settlement duck —
 * and again the instant a new board opens. A lifecycle pause is the one exception: a chat hop
 * mid-race must come back exactly where it left off, so `pauseNow()` never seeks.
 *
 * A SLOW SOCKET IS NOT A DEAD BED. The warm-up makes a cold start rare, not impossible, so the
 * element reports its own health: `canplay` is what starts a board still waiting on data (from the
 * top, at the ambient mix, through the same fade), `stalled` repeats a request the browser
 * dropped, and `error` re-requests a dead stream a bounded number of times per match. All three
 * ask `shouldPlay()` first, so a warm-up that struggles on Home is never a bed on a menu.
 *
 * A CLOSED MINI APP IS SILENT. `visibilitychange` and `blur` cover a chat hop and a native sheet;
 * `pagehide` and Telegram's own `deactivated` are the last events a WebView reliably fires on a
 * close, so the bed is parked there too — at volume 0, with no ramp left ticking behind a dead
 * page.
 */
import { onSettings, settings } from './settings';

/**
 * The track. A static `new URL(..., import.meta.url)` is what tells Vite to emit `bgm.mp3` as a
 * standalone asset of its own: the URL is rewritten in the bundle, the bytes are copied, and the
 * file is never inlined as a data URI (which would put 2.8 MB of base64 into the boot chunk).
 */
const BGM_URL = new URL('./assets/sounds/bgm.mp3', import.meta.url).href;

/**
 * The ambient mix. Noticeably clearer than the first pass — the minimal piano underscore is heard
 * under the board without taking it over. The gameplay voices were trimmed to match, so
 * `move.wav`, `explosion.mp3`, `swoosh.mp3`, the victory fanfare and the defeat fanfare still stay
 * clearly in front of it: the bed is atmosphere, never a competitor.
 */
const TARGET_VOLUME = 0.44;

/** Ramp up when the bed starts or comes back; ramp down when it is switched off. */
const FADE_IN_MS = 500;
const FADE_OUT_MS = 250;

/**
 * The settlement duck. Shorter than a switch fade on purpose: the fanfare that follows the result
 * card is already sounding, and a long crossfade would put two melodies over each other for a
 * quarter of a second. Just long enough to be a fade rather than a cut.
 */
const MATCH_OVER_FADE_MS = 220;

/** One fade tick. ~30 ms is smooth to the ear and cheap enough to be irrelevant to the CPU. */
const FADE_STEP_MS = 30;

/**
 * The pre-buffer's delay. Long enough that Home has painted, the first screen's own requests have
 * gone out and the device has gone idle — short enough that a player who taps Play immediately
 * still finds the track already in cache. It is a timer, not a wait: nothing blocks on it.
 */
const WARM_UP_DELAY_MS = 1800;

/**
 * How many times a dead stream may be re-requested inside one match. Three rides out a flapping
 * mobile link; a file that is genuinely gone must not turn into a retry loop.
 */
const MAX_RECOVERIES = 3;

/** The one shared element, or null in a webview that cannot build one. */
let audio: HTMLAudioElement | null = null;

/** The live fade's handle, so a new ramp (or a pause) can clear the old one. */
let fadeTimer = 0;

/** The app has mounted its first screen; before this, nothing here does any work at all. */
let booted = false;

/** The first trusted gesture has landed, so a WebView will let `play()` through. */
let unlocked = false;

/** The Mini App is hidden or blurred: no audience, so no playback. */
let suspended = false;

/**
 * A settled match is on screen. The result capsule brings its own voice, so the bed is parked
 * until the player leaves it — see `setMusicMatchOver()`. Kept in `shouldPlay()` rather than in a
 * listener, so nothing in this module can resume the bed behind the settlement by accident.
 */
let matchOver = false;

/**
 * A match is genuinely live on the board. This is the STRICT gate the brief asks for, and it is
 * `false` on boot: no bed on Home, Ranks, the Shop, VIP, Squads, Friends, the lobby or any drawer
 * over a menu. Only `setMusicInMatch(true)` — called by the board's own reveal and by a rematch
 * dealt in place — opens it, and `setMusicInMatch(false)` closes it on every exit.
 */
let inMatch = false;

/** Telegram's `deactivated`/`activated` pair is registered once, and only when the SDK has landed. */
let tgBound = false;

/**
 * The background pre-buffer has already been kicked. `warmUpBgm()` is reachable from a timer, the
 * first tap and the Music switch, and only the first of those pays for a `load()`.
 */
let warmed = false;

/** Re-requests spent on this match's stream; a new board opens with a fresh budget. */
let recoveries = 0;

/** The music switch as of the last change, so the tap that turns it ON is read as a gesture. */
let lastEnabled = settings.musicEnabled;

/** The page is actually on screen. A read that headless browsers cannot answer reads as visible. */
function pageHidden(): boolean {
  try { return document.hidden; } catch { return false; }
}

/**
 * True when the bed should be audible right now: a live match, no settlement over it, the Music
 * switch on, the element blessed by a gesture, and the Mini App actually on screen.
 */
function shouldPlay(): boolean {
  return booted && inMatch && !matchOver && settings.musicEnabled && unlocked
    && !suspended && !pageHidden();
}

/**
 * Park the cursor at the top of the track. A seek can be refused on an element whose metadata has
 * not arrived yet, or one that is mid-`load()`, so it is always wrapped: the `canplay` door rewinds
 * again before it starts anything, so a refused seek costs nothing.
 */
function rewind(el: HTMLAudioElement): void {
  try { el.currentTime = 0; } catch { /* not seekable yet: the next start rewinds */ }
}

/**
 * The stream's own health, heard as three media events.
 *
 * A cold socket on a bad mobile link can still be filling the buffer when the board opens, so the
 * element gets to finish the job the warm-up started: `canplay` is "the data is here", and if the
 * board is live and silent it starts the track from the top and fades it up to the mix; `stalled`
 * is a request the browser dropped, so the play attempt is repeated; `error` is a stream that died,
 * so the resource is re-requested — a bounded number of times per match, because a permanently
 * broken file must not become a retry loop.
 *
 * Every branch asks `shouldPlay()` first: a warm-up that stalls while the player is still on Home
 * is just a fetch finishing in its own time, never a bed on a menu.
 */
function armRecovery(el: HTMLAudioElement): void {
  try {
    el.addEventListener('canplay', () => {
      if (!shouldPlay() || !el.paused) return;
      rewind(el);                       // a board waiting on data opens at 0:00
      startBed();                       // and fades in to TARGET_VOLUME like any other start
    });
    el.addEventListener('stalled', () => {
      if (!shouldPlay() || !el.paused) return;
      startBed();                       // re-arm the request the browser gave up on
    });
    el.addEventListener('error', () => {
      if (!shouldPlay() || !el.paused) return;
      if (recoveries >= MAX_RECOVERIES) return;
      recoveries++;
      try { el.load(); } catch { /* nothing left to retry with */ }
    });
  } catch { /* headless: no media events to hear */ }
}

/**
 * The single shared element, built once on first use.
 *
 * `preload` is set BEFORE `src` on purpose: the strategy has to be in place before the browser sees
 * a URL, or it may start fetching on a default it chose rather than the one this module wants.
 * `'auto'` is deliberate — the whole point of `warmUpBgm()` is that the 2.8 MB track is already in
 * the media cache by the time a board opens. Nothing plays here: the element is built at volume 0,
 * and only `warmUpBgm()` (silent) or `startBed()` (after a real `play()`) opens the stream.
 */
function element(): HTMLAudioElement | null {
  if (audio) return audio;
  try {
    const el = new Audio();
    el.preload = 'auto';
    el.loop = true;
    el.volume = 0;
    el.src = BGM_URL;
    /* iOS keeps an inline `<audio>` inline instead of handing it to the fullscreen player */
    el.setAttribute('playsinline', '');
    armRecovery(el);
    audio = el;
  } catch { audio = null; }
  return audio;
}

/** Stop the live fade. Called before every new ramp and before every pause, so no timer leaks. */
function clearFade(): void {
  if (!fadeTimer) return;
  try { window.clearInterval(fadeTimer); } catch { /* no window left to schedule on */ }
  fadeTimer = 0;
}

/** Clamp a level into the element's legal volume window. */
const level = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Ramp the element's own volume from wherever it actually is to `target`, over `ms`, on one
 * timer that clears itself the moment it lands. `then` runs after the last step. A ramp that is
 * interrupted — a toggle, a blur, a second ramp — is simply cleared: never two ramps at once.
 */
function fadeTo(target: number, ms: number, then?: () => void): void {
  const el = audio;
  if (!el) return;
  clearFade();
  const to = level(target);
  let from: number;
  try { from = level(el.volume); } catch { from = 0; }
  if (Math.abs(to - from) < 0.005) {
    try { el.volume = to; } catch { /* refused: stay silent */ }
    then?.();
    return;
  }
  const steps = Math.max(1, Math.round(ms / FADE_STEP_MS));
  let step = 0;
  fadeTimer = window.setInterval(() => {
    step++;
    const v = from + (to - from) * (step / steps);
    try { el.volume = level(v); } catch { clearFade(); return; }
    if (step < steps) return;
    clearFade();
    try { el.volume = to; } catch { /* refused: stay silent */ }
    then?.();
  }, FADE_STEP_MS);
}

/** Take the bed down without a fade — the Mini App is hidden, so nobody is listening anyway. */
function pauseNow(): void {
  clearFade();
  const el = audio;
  if (!el) return;
  try { el.pause(); } catch { /* never started */ }
  try { el.volume = 0; } catch { /* refused: stay silent */ }
}

/**
 * Start (or lift) the bed. `play()` is the only gesture-sensitive call in the app's audio, so it
 * is always wrapped: a restricted WebView gets silence, never an unhandled rejection. The ramp
 * begins when playback truly starts, so the fade is heard rather than spent on a loading buffer.
 */
function startBed(): void {
  const el = element();
  if (!el) return;
  /* already running (a focus after a toggle, say): just lift the level back to the mix */
  if (!el.paused) { fadeTo(TARGET_VOLUME, FADE_IN_MS); return; }
  try {
    const played = el.play();
    if (played && typeof played.then === 'function') {
      void played
        .then(() => {
          if (shouldPlay()) fadeTo(TARGET_VOLUME, FADE_IN_MS);
          else if (!el.paused) pauseNow();
        })
        .catch(() => undefined);
    } else {
      fadeTo(TARGET_VOLUME, FADE_IN_MS);
    }
  } catch { /* a WebView refusal is silence, never an exception */ }
}

/**
 * Fade the bed out over `FADE_OUT_MS`, then park it — the SFX engines are untouched.
 *
 * `fromTop` is what separates the two reasons this runs. Leaving a match (`setMusicInMatch(false)`)
 * parks the cursor as well as the element, so the next race cannot open mid-phrase; a switch or a
 * settings change mid-race does not, because the player is still on that board and a later toggle
 * back on should resume where the music was.
 */
function stopBed(fromTop = false): void {
  const el = audio;
  if (!el) return;
  if (el.paused && el.volume === 0) {
    clearFade();
    if (fromTop) rewind(el);
    return;
  }
  fadeTo(0, FADE_OUT_MS, () => {
    if (shouldPlay()) return;           // switched back on mid-fade: the new ramp owns the element
    try { el.pause(); } catch { /* never started */ }
    if (fromTop) rewind(el);            // the next race opens at 0:00, never mid-phrase
  });
}

/**
 * THE SETTLEMENT DUCK. Down over 220 ms, then parked at 0 — unconditionally, because the match is
 * over and nothing else in this module gets to decide otherwise. `audio` is read directly rather
 * than through `element()`: a player who runs the whole app with Music off must not have a 2.8 MB
 * track element built for a pause that has nothing to pause.
 */
function duckForSettlement(): void {
  const el = audio;
  if (!el) { clearFade(); return; }
  if (el.paused && el.volume === 0) { clearFade(); rewind(el); return; }
  fadeTo(0, MATCH_OVER_FADE_MS, () => {
    try { el.pause(); } catch { /* never started */ }
    try { el.volume = 0; } catch { /* refused: stay silent */ }
    rewind(el);                         // the race is over: the next one starts at the top
  });
}

/**
 * The one door the settlement has into the bed.
 *
 * `true` when the result capsule opens: the bed gets out of the fanfare's way at once and stays
 * out. `false` when the player leaves that capsule — Play again, a rematch, the menu, any new
 * race — and the bed comes back only if it is still wanted: the switch on, the element unlocked,
 * the Mini App on screen. Every other door out of this module routes through `shouldPlay()`, so a
 * tap, a focus or a settings change while the capsule is up is answered with silence.
 */
export function setMusicMatchOver(isOver: boolean): void {
  if (isOver === matchOver) return;     // repeated calls are free: no second ramp, no restart
  matchOver = isOver;
  if (!booted) return;                  // nothing is built yet, and nothing should be
  if (isOver) duckForSettlement();
  else sync();
}

/**
 * The only door into the bed: a match is entering the playable board, or leaving it.
 *
 * `true` — the reveal onto the race (Solo/Bot, local, 1v1, 3P/4P, 2v2, a friend duel) or a rematch
 * dealt in place. The settlement duck is lifted (`matchOver`) because a fresh board has no result
 * on it, and the bed comes up to the ambient mix over `FADE_IN_MS` if it is genuinely wanted: the
 * switch on, a gesture already landed, the Mini App on screen. Anything else is silence, and the
 * first gesture/focus/toggle after this call is what brings it up through `sync()`.
 *
 * `false` — the player quit to the menu, aborted the race, or moved to a non-match screen. The bed
 * ramps down and parks; the element is kept (it is already decoded) so the next match starts at
 * once, and no timer is left ticking.
 */
export function setMusicInMatch(active: boolean): void {
  /* a genuine new board, as opposed to a repeated call from a rematch path */
  const entering = active && !inMatch;
  inMatch = active;
  /* a board being dealt has no verdict on it: the settlement duck belongs to the last race */
  if (active) {
    matchOver = false;
    recoveries = 0;                     // this race gets its own budget of re-requests
  }
  if (!booted) return;                  // nothing is built yet, and nothing should be
  if (active) {
    if (shouldPlay()) {
      const el = element();
      /* EVERY NEW MATCH STARTS AT 0:00. A paused element remembers its cursor, and an aborted
         race leaves it wherever the player quit — so the top of the track is restored before
         `play()` rather than trusted to the last stop. A live bed is never re-seeked: only a
         parked one is rewound, so a repeated call cannot restart the music under a running race. */
      if (el && (entering || el.paused)) rewind(el);
      startBed();                       // fade up to TARGET_VOLUME over FADE_IN_MS
    }
    return;
  }
  stopBed(true);                        // fade down to 0, park, and rewind for the next race
}

/** Reconcile the element with the switches, the gesture and the Mini App's lifecycle. */
function sync(): void {
  if (!booted) return;                  // nothing is created, fetched or decoded during boot
  if (shouldPlay()) startBed();
  else stopBed();
}

/**
 * The silent pre-buffer. Builds the element if it does not exist yet, keeps it at volume 0 and asks
 * the browser for the bytes once — while the player is still on Home — so the board's first
 * `play()` is served from the media cache instead of a cold socket. That is the whole of the
 * startup delay this module used to pay on a slow link, and it is paid by an idle menu instead.
 *
 * It is a no-op in the three cases that must not pay for it: before boot (nothing is mounted), on a
 * live board (the bed already owns the element and `startBed()` is fetching), and with the Music
 * switch off (a player who turned the bed off must not be handed 2.8 MB). `warmed` keeps it to one
 * `load()`: the timer, the first tap and the switch can all call it for the price of a boolean.
 *
 * Nothing here plays, ramps or pauses: `volume` stays 0 and `play()` is never called, so a
 * restricted WebView is not asked for permission it has not granted yet.
 */
function warmUpBgm(): void {
  if (!booted || warmed || inMatch) return;
  if (!settings.musicEnabled) return;
  const el = element();
  if (!el) return;
  warmed = true;
  if (!el.paused) return;               // a live stream: never re-load underneath it
  try { el.volume = 0; } catch { /* refused: stay silent */ }
  try { el.load(); } catch { /* a WebView that refuses load() fetches on the first play */ }
}

/** The first trusted gesture: bless the element and let the bed come up. */
function onFirstTouch(): void {
  if (!booted) return;
  unlocked = true;
  sync();
  warmUpBgm();                          // the same tap that unlocks it also pays for the pre-buffer
}

/**
 * Register the one-time unlock listeners. Only called once the app has booted, so a tap that
 * happens earlier cannot spend the one shot on a page that is not ready to play.
 */
function armUnlock(): void {
  try {
    const opts: AddEventListenerOptions = { once: true, capture: true, passive: true };
    window.addEventListener('pointerdown', onFirstTouch, opts);
    window.addEventListener('touchstart', onFirstTouch, opts);
    window.addEventListener('keydown', onFirstTouch, opts);
  } catch { /* headless: nothing to unlock */ }
}

/**
 * The Mini App lifecycle. Telegram hands the WebView to a chat, a call or the OS lock without
 * warning, and a looping bed must not play on behind it: hidden/blurred pauses immediately, and
 * becoming visible/focused again lifts it back to the ambient level when the switch is still on.
 *
 * `pagehide` is the close. It is the last event a WebView reliably delivers when the Mini App is
 * dismissed or the page is frozen into the back/forward cache, and it can arrive without a
 * `visibilitychange` — so it parks the bed at 0 with no ramp left ticking. `pageshow` is its
 * counterpart: a restored page is silent until the bed is asked for again, and the visibility
 * flag decides whether that is now.
 */
function armLifecycle(): void {
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        suspended = true;
        pauseNow();
      } else {
        suspended = false;
        sync();
      }
    });
    window.addEventListener('blur', () => {
      suspended = true;
      pauseNow();
    });
    window.addEventListener('focus', () => {
      suspended = false;
      sync();
    });
    window.addEventListener('pagehide', () => {
      suspended = true;
      pauseNow();
    });
    window.addEventListener('pageshow', () => {
      /* a bfcache restore can report a visible page that is still in the background stack */
      suspended = document.hidden;
      sync();
    });
  } catch { /* headless: no lifecycle to honour */ }
  armTelegramLifecycle();
}

/**
 * Telegram's own lifecycle, which fires where the DOM's does not. `deactivated` is what the client
 * sends when the Mini App is closed or covered by another chat; `activated` is the way back. Both
 * are 6.1 events, and an older client answers every `onEvent` with an "unsupported" warning line —
 * so the version is checked first, exactly as `telegram.ts` does for its own two.
 *
 * The SDK is read live from `window` rather than imported: this module is deliberately one
 * dependency (`settings`) and one `<audio>` element, and a Mini App without the SDK simply keeps
 * the DOM listeners above. `telegram-web-app.js` is deferred, so a boot that beat it here retries
 * on the script's own load and on the page's — the same two doors `telegram.ts` waits behind, and
 * no polling. `tgBound` keeps the pair registered exactly once.
 */
function armTelegramLifecycle(): void {
  try {
    if (tgBound) return;
    const app = window.Telegram?.WebApp;
    if (!app || typeof app.onEvent !== 'function') {
      const script = document.querySelector<HTMLScriptElement>('script[src*="telegram-web-app"]');
      script?.addEventListener('load', armTelegramLifecycle, { once: true });
      window.addEventListener('load', armTelegramLifecycle, { once: true });
      return;
    }
    const check = app.isVersionAtLeast;
    if (typeof check === 'function' && !check.call(app, '6.1')) return;
    tgBound = true;
    app.onEvent('deactivated', () => {
      suspended = true;
      pauseNow();
    });
    app.onEvent('activated', () => {
      suspended = document.hidden;
      sync();
    });
  } catch { /* not inside Telegram, or an SDK that refuses the listener */ }
}

/**
 * Boot hook, called once from `main.ts` after the first screen has mounted. Everything this module
 * does to the page — the unlock listeners, the lifecycle listeners and the settings watcher — is
 * registered here rather than at import, so the boot itself pays nothing for the bed.
 */
export function initMusic(): void {
  if (booted) return;
  booted = true;
  /* a Mini App that booted behind another chat must not start a bed nobody is listening to */
  try { suspended = document.hidden; } catch { suspended = false; }
  /* The Music row may already have been switched off on a previous launch: in that case the
     element is never even built, and the row turns it on later. */
  armUnlock();
  armLifecycle();
  onSettings(() => {
    const enabled = settings.musicEnabled;
    /* the toggle's own tap is a trusted gesture: turning the bed ON unlocks it directly */
    if (enabled && !lastEnabled) unlocked = true;
    lastEnabled = enabled;
    sync();
    /* switching the bed on is also the moment to fill the cache, so the first race is not cold */
    if (enabled) warmUpBgm();
  });
  sync();
  /* The pre-buffer waits for boot to settle: Home paints with the device's whole pipe first, and
     a tap that lands sooner warms it through `onFirstTouch()` instead. Never a blocking wait. */
  try { window.setTimeout(warmUpBgm, WARM_UP_DELAY_MS); } catch { /* no timers: the tap warms it */ }
}
