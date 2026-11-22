/**
 * music.ts — the ambient bed: one looping track behind the arena, and the one switch that owns it.
 *
 * It is deliberately a separate voice from `sound.ts`/`audio.ts`. Those two share the app's
 * AudioContext and every gameplay SFX; this module owns nothing but `<audio>`, so the Music switch
 * in Settings can silence the bed without touching a step, a blast or a fanfare, and the Sound
 * switch never silences the bed. The two switches are independent by construction, not by a flag
 * both engines read.
 *
 * BOOT COST IS ZERO. `bgm.mp3` is ~2.8 MB, so it must never ride the first frame: the URL is a
 * plain `new URL(..., import.meta.url)` so Vite emits it as its own static asset (never inlined
 * into JS), the element is `preload = 'none'`, and the element is not even created until playback
 * is genuinely wanted — after the app has mounted and the player has touched the page. The fetch
 * and the decode happen on that first gesture, in the background, where they cannot delay Home,
 * matchmaking or the board.
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
 */
import { onSettings, settings } from './settings';

/**
 * The track. A static `new URL(..., import.meta.url)` is what tells Vite to emit `bgm.mp3` as a
 * standalone asset of its own: the URL is rewritten in the bundle, the bytes are copied, and the
 * file is never inlined as a data URI (which would put 2.8 MB of base64 into the boot chunk).
 */
const BGM_URL = new URL('./assets/sounds/bgm.mp3', import.meta.url).href;

/**
 * The ambient mix. Warm enough to be heard under the board, quiet enough that `move.wav`,
 * `explosion.mp3`, `swoosh.mp3`, the victory fanfare and the defeat fanfare all stay clearly in
 * front of it — the bed is atmosphere, never a competitor.
 */
const TARGET_VOLUME = 0.22;

/** Ramp up when the bed starts or comes back; ramp down when it is switched off. */
const FADE_IN_MS = 500;
const FADE_OUT_MS = 250;

/** One fade tick. ~30 ms is smooth to the ear and cheap enough to be irrelevant to the CPU. */
const FADE_STEP_MS = 30;

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

/** The music switch as of the last change, so the tap that turns it ON is read as a gesture. */
let lastEnabled = settings.musicEnabled;

/** True when the bed should be audible right now. */
function shouldPlay(): boolean {
  return booted && unlocked && !suspended && settings.musicEnabled;
}

/**
 * The single shared element, built once on first use.
 *
 * `preload` is set BEFORE `src` on purpose: a browser that sees a `src` first may start fetching
 * immediately, and the whole point of this module is that a 2.8 MB track never competes with the
 * first frame. Nothing calls `load()`; playback is what opens the stream.
 */
function element(): HTMLAudioElement | null {
  if (audio) return audio;
  try {
    const el = new Audio();
    el.preload = 'none';
    el.loop = true;
    el.volume = 0;
    el.src = BGM_URL;
    /* iOS keeps an inline `<audio>` inline instead of handing it to the fullscreen player */
    el.setAttribute('playsinline', '');
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

/** Fade the bed out over `FADE_OUT_MS`, then park it — the SFX engines are untouched. */
function stopBed(): void {
  const el = audio;
  if (!el) return;
  if (el.paused && el.volume === 0) { clearFade(); return; }
  fadeTo(0, FADE_OUT_MS, () => {
    if (shouldPlay()) return;           // switched back on mid-fade: the new ramp owns the element
    try { el.pause(); } catch { /* never started */ }
  });
}

/** Reconcile the element with the switches, the gesture and the Mini App's lifecycle. */
function sync(): void {
  if (!booted) return;                  // nothing is created, fetched or decoded during boot
  if (shouldPlay()) startBed();
  else stopBed();
}

/** The first trusted gesture: bless the element and let the bed come up. */
function onFirstTouch(): void {
  if (!booted) return;
  unlocked = true;
  sync();
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
  } catch { /* headless: no lifecycle to honour */ }
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
  });
  sync();
}
