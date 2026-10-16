/**
 * sound.ts — the game's audio voices. A single `AudioContext` and two decoded buffers — `move.wav`
 * for steps and leaps, `explosion.mp3` for mine detonations — live here for the whole session, so a
 * step or a blast is a node graph a few microseconds wide: no fetch, no decode, no second context
 * anywhere in the app.
 *
 * Mobile webviews refuse to start an `AudioContext` until the page has been touched, and creating
 * one early only earns a console warning. So the engine is built lazily: the first
 * pointerdown/touchstart anywhere unlocks the context and kicks off the two decodes, and every
 * `playMove`/`playExplosion` after that is fire-and-forget. Before a buffer lands (or if a webview
 * has no WebAudio at all) the board simply races quietly — nothing here is allowed to throw, block
 * or leak on the way out.
 */
import { settings } from './settings';
import moveWav from './assets/sounds/move.wav';
import explosionMp3 from './assets/sounds/explosion.mp3';

/** The base gain for one step: warm in the mix, never the loudest thing in the room. */
const MOVE_GAIN = 0.65;

/** The human's own step at full; a rival's sits behind it rather than under the player's hand. */
export const RIVAL_MOVE_GAIN = 0.55;

/**
 * One detonation: a subterranean boom that owns the mix without clipping it — a touch below full
 * scale, so the blasts of a four-ball table can stack over a step trail and still leave headroom.
 */
const EXPLOSION_GAIN = 0.9;

let ctx: AudioContext | null = null;
let moveBuffer: AudioBuffer | null = null;
let explosionBuffer: AudioBuffer | null = null;
let decoding = false;

/** The one context, created on first use — never on import, so no autoplay warning at startup. */
function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    ctx = Ctor ? new Ctor() : null;
  } catch { ctx = null; }               // a webview with WebAudio switched off: stay silent
  return ctx;
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

/** Fetch and decode both voices exactly once; calls while they are in flight are dropped. */
function prime(c: AudioContext): void {
  if (decoding || (moveBuffer && explosionBuffer)) return;
  decoding = true;
  const jobs: Promise<void>[] = [];
  if (!moveBuffer) jobs.push(decode(c, moveWav).then((buf) => { moveBuffer = buf; }));
  if (!explosionBuffer) jobs.push(decode(c, explosionMp3).then((buf) => { explosionBuffer = buf; }));
  void Promise.allSettled(jobs)
    .catch(() => { /* allSettled never rejects; belt and braces */ })
    .finally(() => { decoding = false; });
}

/** The first gesture anywhere: build the engine, start the two decodes, lift the suspension. */
function unlock(): void {
  const c = context();
  if (!c) return;
  resume(c);
  prime(c);
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
    src.connect(gain).connect(c.destination);
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
    src.connect(gain).connect(c.destination);
    src.onended = () => { src.disconnect(); gain.disconnect(); };
    src.start();
  } catch { /* a node graph refusal must never take a turn down with it */ }
}

/** The shared context for the app's other voices (the matchmaking chime), or null without WebAudio. */
export function audioContext(): AudioContext | null {
  return context();
}
