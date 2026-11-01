/**
 * sound.ts — the game's audio voices. A single `AudioContext` and three decoded buffers —
 * `move.wav` for steps and leaps, `explosion.mp3` for mine detonations and `defeat.m4a` for the
 * post-match defeat fanfare — live here for the whole session, so a step or a blast is a node graph
 * a few microseconds wide: no fetch, no decode, no second context anywhere in the app.
 *
 * Mobile webviews refuse to start an `AudioContext` until the page has been touched, and creating
 * one early only earns a console warning. So the engine is built lazily: the first
 * pointerdown/touchstart anywhere unlocks the context and kicks off the decodes, and every
 * `playMove`/`playExplosion` after that is fire-and-forget. Before a buffer lands (or if a webview
 * has no WebAudio at all) the board simply races quietly — nothing here is allowed to throw, block
 * or leak on the way out.
 *
 * The defeat fanfare is the one voice here with a lifetime. It is single-shot per result, it ducks
 * the session mix while it speaks, and `stopDefeat` hands the mix back with a fade when the result
 * capsule lets go. A cached `<audio>` element — blessed by the first tap — is the Safari/iOS
 * fallback for a frame where the Web Audio graph is suspended, interrupted or unavailable.
 */
import { onSettings, settings } from './settings';
import moveWav from './assets/sounds/move.wav';
import explosionMp3 from './assets/sounds/explosion.mp3';
import defeatM4a from './assets/sounds/defeat.m4a';

/** The base gain for one step: warm in the mix, never the loudest thing in the room. */
const MOVE_GAIN = 0.65;

/** The human's own step at full; a rival's sits behind it rather than under the player's hand. */
export const RIVAL_MOVE_GAIN = 0.55;

/**
 * One detonation: a subterranean boom that owns the mix without clipping it — a touch below full
 * scale, so the blasts of a four-ball table can stack over a step trail and still leave headroom.
 */
const EXPLOSION_GAIN = 0.9;

/**
 * The defeat fanfare: the result screen's one long voice on a loss. A touch under full scale so the
 * settlement's count-up still reads underneath it.
 */
const DEFEAT_GAIN = 0.9;

/** How long the fanfare's own tail gets when the capsule lets go: a fade, never a cut. */
const DEFEAT_FADE_S = 0.35;

/** A few milliseconds of lead, so the graph reaches the render thread before the first sample. */
const DEFEAT_LEAD_S = 0.03;

/**
 * How far the session mix ducks while the defeat fanfare speaks. Every other voice in this engine —
 * steps, blasts, the reward chime, and any looping music/ambient bed the app ever adds — lands on
 * `mixGain`; only the fanfare is wired past it. The duck is therefore heard as the fanfare taking
 * the speakers, never as the fanfare turning itself down.
 */
const DEFEAT_DUCK_LEVEL = 0.18;
const DEFEAT_DUCK_FADE_S = 0.22;
const DEFEAT_RESTORE_FADE_S = 0.4;

let ctx: AudioContext | null = null;
let moveBuffer: AudioBuffer | null = null;
let explosionBuffer: AudioBuffer | null = null;
let defeatBuffer: AudioBuffer | null = null;
let decoding = false;

/**
 * The session mix every short voice routes through. It stays at 1 except while the defeat fanfare
 * ducks it; the fanfare's own node is connected straight to `destination`, so it is unaffected.
 */
let mixGain: GainNode | null = null;

/** The one context, created on first use — never on import, so no autoplay warning at startup. */
function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    const c = new Ctor();
    /* The duck lives on this node. Built with the context, so a play path can never find it null
       while the context exists. */
    const mix = c.createGain();
    mix.gain.value = 1;
    mix.connect(c.destination);
    mixGain = mix;
    ctx = c;
  } catch { ctx = null; mixGain = null; }  // a webview with WebAudio switched off: stay silent
  return ctx;
}

/** Every short voice lands on the mix node; the defeat fanfare is the one voice wired past it. */
function mixOf(c: AudioContext): AudioNode {
  return mixGain ?? c.destination;
}

/**
 * Resume a context the OS parked. Chrome hands out a suspended one until a gesture, iOS can
 * interrupt it on a call or a lock, and a backgrounded tab suspends it again — every play path
 * calls through here so the next step always finds the clock running.
 */
function resume(c: AudioContext): void {
  if (c.state !== 'running') void c.resume().catch(() => { /* still locked: no sound yet */ });
}

/** Fetch and decode one asset into a buffer, rejecting on a missing or undecodable file. */
function decode(c: AudioContext, url: string): Promise<AudioBuffer> {
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    })
    .then((raw) => new Promise<AudioBuffer>((ok, err) => c.decodeAudioData(raw, ok, err)));
}

/** Fetch and decode every voice exactly once; calls while they are in flight are dropped. */
function prime(c: AudioContext): void {
  if (decoding || (moveBuffer && explosionBuffer && defeatBuffer)) return;
  decoding = true;
  const jobs: Promise<void>[] = [];
  if (!moveBuffer) jobs.push(decode(c, moveWav).then((buf) => { moveBuffer = buf; }));
  if (!explosionBuffer) jobs.push(decode(c, explosionMp3).then((buf) => { explosionBuffer = buf; }));
  if (!defeatBuffer) jobs.push(decode(c, defeatM4a).then((buf) => { defeatBuffer = buf; }));
  void Promise.allSettled(jobs)
    .catch(() => { /* allSettled never rejects; belt and braces */ })
    .finally(() => { decoding = false; });
}

/* ---------- the HTML5 fallback for the fanfare ---------- */

/**
 * Safari/iOS can suspend or interrupt the graph after a call, a lock or a backgrounded Mini App,
 * and a webview with WebAudio switched off has no graph at all. `defeat.m4a` is already the one
 * asset a plain `<audio>` element can carry, so a cached element is the defeat voice's safety net.
 * It is built on the first gesture — never on import — and played muted once *inside* that
 * gesture: iOS only blesses later playback from a non-gesture frame (the result banner) after the
 * element has spoken once under a finger.
 */
let fallback: HTMLAudioElement | null = null;
let fallbackPrimed = false;
/** Bumped whenever a real fanfare takes the element, so a slow unlock cannot pause it. */
let fallbackEpoch = 0;

function fallbackElement(): HTMLAudioElement | null {
  if (fallback) return fallback;
  try {
    const el = new Audio(defeatM4a);
    el.preload = 'auto';
    /* the element's own tail hands the mix back even when the graph never owned the voice */
    el.addEventListener('ended', () => { restoreMix(); });
    fallback = el;
  } catch { fallback = null; }
  return fallback;
}

/** Rewind the fallback without ever letting a half-loaded element throw into the result screen. */
function rewind(el: HTMLAudioElement): void {
  try { el.pause(); } catch { /* never played */ }
  try { el.currentTime = 0; } catch { /* metadata not in yet */ }
}

/**
 * The first gesture's muted play/pause. It costs no audible sample and is what makes the element
 * legal to start from the banner's non-gesture frame on iOS. A refused unlock leaves the Web Audio
 * path in charge, so nothing breaks when a webview says no.
 */
function primeFallback(): void {
  const el = fallbackElement();
  if (!el || fallbackPrimed) return;
  fallbackPrimed = true;
  const epoch = ++fallbackEpoch;
  try {
    el.muted = true;
    const played = el.play();
    const settle = (): void => {
      if (epoch !== fallbackEpoch) return;  // a real fanfare took the element in the meantime
      rewind(el);
      el.muted = false;
    };
    if (played && typeof played.then === 'function') {
      void played.then(settle).catch(() => { el.muted = false; });
    } else settle();
  } catch { el.muted = false; }
}

/** The first gesture anywhere: build the engine, start the decodes, bless the fallback. */
function unlock(): void {
  const c = context();
  if (c) { resume(c); prime(c); }
  primeFallback();
}

/* Capture phase, so a board handler that stops a tap from bubbling cannot starve the engine. */
try {
  const opts: AddEventListenerOptions = { once: true, capture: true, passive: true };
  window.addEventListener('pointerdown', unlock, opts);
  window.addEventListener('touchstart', unlock, opts);
} catch { /* headless: nothing to unlock */ }

/**
 * One step or leap, fire-and-forget. Each play gets its own `AudioBufferSourceNode` with
 * `playbackRate` jittered ±4% so fifty consecutive moves never machine-gun, and its own gain so
 * a rival's step can sit behind the player's. Nodes disconnect themselves the moment they end:
 * nothing is retained after playback.
 */
export function playMove(volume = 1): void {
  if (!settings.sound) return;
  const c = context();
  if (!c) return;
  resume(c);
  prime(c);
  const buf = moveBuffer;
  if (!buf) return;                     // still decoding: the first tap warms it, the next rings
  try {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.96 + Math.random() * 0.08;
    const gain = c.createGain();
    gain.gain.value = MOVE_GAIN * volume;
    src.connect(gain).connect(mixOf(c));
    src.onended = () => { src.disconnect(); gain.disconnect(); };
    src.start();
  } catch { /* a node graph refusal must never take a turn down with it */ }
}

/**
 * One mine detonation, fire-and-forget. The cached buffer makes the boom land on the same frame as
 * the blast animation; `playbackRate` is jittered ±5% so repeated triggers keep their edge. The
 * node graph tears itself down on `ended`, and the global sound switch gates the whole call.
 */
export function playExplosion(): void {
  if (!settings.sound) return;
  const c = context();
  if (!c) return;
  resume(c);
  prime(c);
  const buf = explosionBuffer;
  if (!buf) return;                     // still decoding: the blast is silent, the next one is not
  try {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.95 + Math.random() * 0.1;
    const gain = c.createGain();
    gain.gain.value = EXPLOSION_GAIN;
    src.connect(gain).connect(mixOf(c));
    src.onended = () => { src.disconnect(); gain.disconnect(); };
    src.start();
  } catch { /* a node graph refusal must never take a turn down with it */ }
}

/** The shared context for the app's other voices (the matchmaking chime), or null without WebAudio. */
export function audioContext(): AudioContext | null {
  return context();
}

/**
 * The reward chime: three struck notes (E5–G5–C6) on the shared context, fire-and-forget. It needs
 * no decoded asset — each note is a short triangle oscillator with an exponential decay — so the
 * claim's sound lands on the tap's own frame. Gated by the Sound switch like every other voice,
 * and a node-graph refusal can never take the claim down with it.
 */
export function playReward(): void {
  if (!settings.sound) return;
  const c = context();
  if (!c) return;
  resume(c);
  const NOTES = [659.25, 783.99, 1046.5];
  try {
    const t0 = c.currentTime + 0.01;
    NOTES.forEach((freq, i) => {
      const at = t0 + i * 0.09;
      const osc = c.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.26, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
      osc.connect(gain).connect(mixOf(c));
      osc.onended = () => { osc.disconnect(); gain.disconnect(); };
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch { /* a node graph refusal must never take the claim down with it */ }
}

/* ---------- the defeat fanfare: the one long voice ---------- */

/** The live fanfare voice and its own gain, or null between screens. */
let defeatSrc: AudioBufferSourceNode | null = null;
let defeatGain: GainNode | null = null;
/** The context time the live voice was scheduled for; a stop before it needs no fade. */
let defeatStartsAt = 0;
/** One fanfare per match, however many repaints that result goes through. */
let defeatPlayed = false;

/** Smoothly move the session mix to `target` — from wherever it actually is, so ducks never jump. */
function rampMix(target: number, seconds: number): void {
  const c = ctx;
  const mix = mixGain;
  if (!c || !mix) return;
  try {
    const now = c.currentTime;
    mix.gain.cancelScheduledValues(now);
    mix.gain.setValueAtTime(mix.gain.value, now);
    mix.gain.linearRampToValueAtTime(target, now + Math.max(0.02, seconds));
  } catch { /* a ramp refusal is a silent mix, never a broken result screen */ }
}

/** Drop the session's other voices under the fanfare. */
function duckMix(): void { rampMix(DEFEAT_DUCK_LEVEL, DEFEAT_DUCK_FADE_S); }

/** Hand the mix its level back once the fanfare is done or the screen let go of it. */
function restoreMix(): void { rampMix(1, DEFEAT_RESTORE_FADE_S); }

/**
 * Start the decoded fanfare past the mix. Returns whether the voice was actually scheduled, so the
 * caller can fall through to the HTML5 element when the graph refuses.
 */
function startDefeatVoice(c: AudioContext, buf: AudioBuffer): boolean {
  try {
    const src = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.value = DEFEAT_GAIN;
    /* straight to the speakers: the duck must never lower the fanfare that asked for it */
    src.connect(gain).connect(c.destination);
    src.onended = () => {
      if (defeatSrc === src) { defeatSrc = null; defeatGain = null; defeatStartsAt = 0; }
      src.disconnect();
      gain.disconnect();
      restoreMix();
    };
    defeatSrc = src;
    defeatGain = gain;
    duckMix();
    defeatStartsAt = Math.max(c.currentTime, c.currentTime + DEFEAT_LEAD_S);
    src.start(defeatStartsAt);
    return true;
  } catch {
    defeatSrc = null;
    defeatGain = null;
    defeatStartsAt = 0;
    restoreMix();
    return false;
  }
}

/** The element's voice: used when the graph cannot speak, or has not decoded the asset yet. */
function playDefeatFallback(): void {
  const el = fallbackElement();
  if (!el) return;
  fallbackEpoch++;                      // a slow unlock must not pause this voice
  duckMix();
  rewind(el);
  try {
    el.muted = false;
    el.volume = Math.min(1, DEFEAT_GAIN);
    const played = el.play();
    if (played && typeof played.catch === 'function') {
      void played.catch(() => { restoreMix(); });   // iOS refused: silence, never an exception
    }
  } catch { restoreMix(); }
}

/**
 * The post-match defeat fanfare, fired the moment the loss banner and the result card land.
 *
 * It is the one voice with a lifetime, so it keeps its handles: the screen must be able to take it
 * back when the player leaves the result or an ad takes the speakers. Gated by the Sound switch
 * like every other voice. A match gets exactly one: the shot is claimed before any gate, so a
 * second call from the same result frame, a repaint or an ad release cannot stack the track.
 *
 * The Web Audio path is used only while its context is actually running. A suspended one — iOS
 * handing the Mini App back from the background — would hold a scheduled source until the next
 * gesture, so the already-blessed `<audio>` element speaks instead and the banner is never silent.
 */
export function playDefeat(): void {
  if (defeatPlayed || defeatSrc) return;
  defeatPlayed = true;                  // one shot per match, claimed even when a gate drops it
  if (!settings.sound) return;
  const c = context();
  const buf = defeatBuffer;
  if (c && buf && c.state === 'running' && startDefeatVoice(c, buf)) return;
  playDefeatFallback();
}

/**
 * Hand the defeat fanfare back: a short fade on its own gain, the element paused, and the session
 * mix restored — so leaving the result screen cuts a tail rather than clipping one, and the next
 * loss is armed again. Idempotent, and safe to call when nothing is playing.
 */
export function stopDefeat(): void {
  /* dismissing the capsule is what makes the next match's fanfare audible */
  defeatPlayed = false;
  fallbackEpoch++;                      // a pending unlock must not pause the next voice
  const el = fallback;
  if (el) {
    rewind(el);
    try { el.muted = false; } catch { /* ignore */ }
  }
  const src = defeatSrc;
  const gain = defeatGain;
  const startsAt = defeatStartsAt;
  defeatSrc = null;
  defeatGain = null;
  defeatStartsAt = 0;
  if (src) {
    const c = ctx;
    try {
      if (!c || c.currentTime < startsAt) src.stop();   // never sounded: nothing to fade
      else {
        const now = c.currentTime;
        if (gain) {
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + DEFEAT_FADE_S);
        }
        src.stop(now + DEFEAT_FADE_S + 0.02);
      }
    } catch { try { src.stop(); } catch { /* already gone */ } }
  }
  restoreMix();
}

/* ---------- the engine's own lifecycle ---------- */

/* The Sound row is a hard mute for the whole app: a fanfare already in flight stops rather than
   playing on into a silent app. */
onSettings(() => { if (!settings.sound) stopDefeat(); });

/* A hidden Mini App has no audience: the fanfare is taken back, and the fallback element is
   paused, so nothing plays on behind Telegram or under the OS lock screen. */
try {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopDefeat();
  });
  window.addEventListener('pagehide', () => { stopDefeat(); });
} catch { /* headless: no lifecycle to honour */ }
