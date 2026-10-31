/**
 * audio.ts — the race's sound engine. One `AudioContext`, six decoded assets (`move.wav`,
 * `explosion.mp3`, `laugh.mp3`, `angry.wav`, `swoosh.mp3`, `01-victory-fan.ogg`) and one master
 * gain: every voice is a `BufferSource` on the graph, scheduled against the context clock so a
 * step, a wall or a blast lands on the frame that caused it rather than the frame after.
 *
 * The context is built at startup and the decodes start with it, but a mobile webview keeps it
 * suspended and silent until the page has been touched: the first `pointerdown` (the Play tap
 * included) resumes it, and `play` is a no-op until then. Nothing here is allowed to throw, block
 * or leak into gameplay.
 */
import { onSettings, settings } from './settings';
import moveWav from './assets/sounds/move.wav';
import explosionMp3 from './assets/sounds/explosion.mp3';
import laughMp3 from './assets/sounds/laugh.mp3';
import angryWav from './assets/sounds/angry.wav';
import swooshMp3 from './assets/sounds/swoosh.mp3';
import victoryFanOgg from './assets/sounds/01-victory-fan.ogg';

export type SoundName = 'move' | 'explosion' | 'laugh' | 'angry' | 'swoosh';

/**
 * How far ahead of `currentTime` an immediate play is scheduled: enough for the node graph to be
 * built and handed to the render thread before its start time arrives, so the first sample is never
 * clipped.
 */
const SCHEDULE_LEAD_S = 0.03;

/** Fast moves must not machine-gun: `move.wav` is limited to one play per this many milliseconds. */
const MOVE_GAP_MS = 40;

/**
 * The laugh, one voice among the race's: loud enough to carry over a step trail, a touch under the
 * blast's full scale so a stacked chorus of taps still leaves the master its headroom.
 */
const LAUGH_GAIN = 0.8;

/**
 * The growl: the laugh's sibling — a touch above it because a grunt carries less than a laugh
 * at the same level, still under full scale so the blast keeps its headroom.
 */
const ANGRY_GAIN = 0.85;

/** Hammering the "Grrr!" pod must not stack into a stutter: one growl per this many milliseconds. */
const ANGRY_GAP_MS = 150;

/**
 * The clash swoosh: the VS cards landing on the crest, a touch under full scale so it owns the
 * moment without out-shouting the blast it replaces.
 */
const SWOOSH_GAIN = 0.9;

/**
 * The victory fanfare: the result screen's one long voice. A touch under full scale so the
 * count-up underneath it still reads, and it fades rather than cuts when the screen lets go, so
 * the tail never clicks or bleeds under an ad.
 */
const VICTORY_GAIN = 0.9;
const VICTORY_FADE_S = 0.22;

/** Where the volume lives. The mute half is `settings.sound`, persisted by `settings.ts`. */
const VOLUME_KEY = 'detour.audio.volume.v1';

interface Engine {
  ctx: AudioContext;
  master: GainNode;
}

let engine: Engine | null = null;
try {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 1;
  master.connect(ctx.destination);
  engine = { ctx, master };
} catch { engine = null; }   // a webview without WebAudio: the board simply races quietly

/** Every voice, decoded once at startup and kept for the session. */
const buffers: Partial<Record<SoundName, AudioBuffer>> = {};

/** The fanfare is not fire-and-forget, so it keeps its own decoded buffer outside the voice table. */
let victoryBuffer: AudioBuffer | null = null;

/**
 * The context's own output latency, read when the context starts running and subtracted from every
 * start time so the sound leaves the speaker with the frame, not a headset's worth of milliseconds
 * after it. 0 when the browser does not report one.
 */
export let OUTPUT_LATENCY_S = 0;

function readLatency(ctx: AudioContext): number {
  try {
    const v = ctx.outputLatency;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function decodeInto(url: string, store: (buf: AudioBuffer) => void): void {
  const e = engine;
  if (!e) return;
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    })
    .then((raw) => e.ctx.decodeAudioData(raw))
    .then(store)
    .catch(() => { /* a missing or undecodable asset is a silent voice, never a broken game */ });
}

function decode(name: SoundName, url: string): void {
  decodeInto(url, (buf) => { buffers[name] = buf; });
}

decode('move', moveWav);
decode('explosion', explosionMp3);
decode('laugh', laughMp3);
decode('angry', angryWav);
decode('swoosh', swooshMp3);
decodeInto(victoryFanOgg, (buf) => { victoryBuffer = buf; });

/** The first gesture anywhere — the Play tap counts — lifts the suspension for the rest of the page. */
let unlocked = false;
function unlock(): void {
  const e = engine;
  if (unlocked || !e) return;
  unlocked = true;
  void e.ctx.resume()
    .then(() => { OUTPUT_LATENCY_S = readLatency(e.ctx); })
    .catch(() => { /* still locked: no sound yet */ });
}

try {
  window.addEventListener('pointerdown', unlock, { once: true, capture: true, passive: true });
} catch { /* headless: nothing to unlock */ }

/* ---------- the master: mute follows Settings, volume is remembered ---------- */

function readVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const n = raw === null ? 1 : Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
  } catch { return 1; }
}

let volume = readVolume();

/**
 * An ad break owns the speakers. This is a mute, not a pause of the graph: the master drops to
 * zero and `play` refuses at the door, so no voice is scheduled under a fullscreen video. It is
 * reversible by construction and it never touches the saved volume — nothing here can leave the
 * game silent once `releaseAudio` has run.
 */
let adHold = false;

function applyGain(): void {
  if (engine) engine.master.gain.value = settings.sound && !adHold ? volume : 0;
}
applyGain();
onSettings(applyGain);       // the Sound row in Settings mutes the whole engine, instantly

/**
 * Silence the engine for an ad. Idempotent: two overlapping holds are one hold. The victory
 * fanfare is stopped, not merely muted — the master alone would hand its tail back the moment
 * `releaseAudio` runs, after the video has already had the speakers.
 */
export function holdAudio(): void {
  if (adHold) return;
  adHold = true;
  stopVictoryFanfare();
  applyGain();
}

/** Hand the speakers back, honouring whatever the Sound row says right now. */
export function releaseAudio(): void {
  if (!adHold) return;
  adHold = false;
  applyGain();
}

/** Set the engine's volume (0..1), persisted for the next visit. */
export function setVolume(v: number): void {
  volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  try { window.localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* stay in memory */ }
  applyGain();
}

/* ---------- the voices ---------- */

export interface PlayOptions {
  /** One voice's own level, 0..1, when full scale would not sit in the mix. Omitted is full scale. */
  gain?: number;
}

let lastMoveAt = -Infinity;
let lastAngryAt = -Infinity;

/**
 * One voice, fire-and-forget: a fresh `BufferSource` per call, routed through the master gain.
 * A play queued before the first gesture, before its buffer has decoded, or while muted is dropped.
 * `move` is rate-limited so a fast trail of steps reads as a trail, not a stack; `angry` gets the
 * same treatment in a longer window, so a mashed "Grrr!" restarts cleanly instead of overlapping.
 */
function play(name: SoundName, opts: PlayOptions = {}): void {
  const e = engine;
  if (!unlocked || !settings.sound || adHold || !e) return;
  if (name === 'move') {
    const now = performance.now();
    if (now - lastMoveAt < MOVE_GAP_MS) return;
    lastMoveAt = now;
  }
  if (name === 'angry') {
    const now = performance.now();
    if (now - lastAngryAt < ANGRY_GAP_MS) return;
    lastAngryAt = now;
  }
  const buf = buffers[name];
  if (!buf) return;                    // still decoding: the first tap warms it, the next rings
  const { ctx, master } = e;
  if (ctx.state !== 'running') void ctx.resume().catch(() => { /* still locked */ });
  const when = Math.max(ctx.currentTime, ctx.currentTime + SCHEDULE_LEAD_S - OUTPUT_LATENCY_S);
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    let voice: GainNode | null = null;
    if (opts.gain !== undefined && opts.gain !== 1) {
      voice = ctx.createGain();
      voice.gain.value = Math.min(1, Math.max(0, opts.gain));
      src.connect(voice).connect(master);
    } else src.connect(master);
    src.onended = () => { src.disconnect(); voice?.disconnect(); };
    src.start(when);
  } catch { /* a node graph refusal must never take a turn down with it */ }
}

/**
 * The "Haha!" emote, fire-and-forget. Every tap gets its own `BufferSource`, so rapid taps stack
 * as a chorus instead of cutting the last laugh off; the buffer is decoded with the engine, so the
 * voice is already cached by the time the sheet opens. Muted or locked, the call is a no-op.
 */
export function playLaugh(): void {
  play('laugh', { gain: LAUGH_GAIN });
}

/**
 * The VS clash swoosh, fire-and-forget: fired the frame the two cards meet at the crest. Gated by
 * the Sound switch and the master volume like every other voice.
 */
export function playSwoosh(): void {
  play('swoosh', { gain: SWOOSH_GAIN });
}

/**
 * The "Grrr!" emote, fire-and-forget. The buffer is decoded with the engine, so the growl is
 * already cached by the time the fury pod is tapped or the rival's bubble arrives; a repeat inside
 * `ANGRY_GAP_MS` is dropped, so mashing the pod yields one clean growl from sample 0, never a
 * layered stutter. Muted or locked, the call is a no-op like every other voice.
 */
export function playAngrySound(): void {
  play('angry', { gain: ANGRY_GAIN });
}

/* ---------- the victory fanfare: the one voice with a lifetime ---------- */

/** The live fanfare voice and its own gain, or null between screens. */
let victorySrc: AudioBufferSourceNode | null = null;
let victoryGain: GainNode | null = null;
/** The context time the live voice was scheduled for; a stop before it needs no fade. */
let victoryStartsAt = 0;
/** One fanfare per victory screen, however many repaints that screen goes through. */
let victoryPlayed = false;

/**
 * The post-match fanfare, fired the moment the victory card and its podium land. It is the one
 * voice that is not fire-and-forget, so it keeps its handles: the screen must be able to take it
 * back when the player leaves or an ad takes the speakers. Gated by the Sound switch, the saved
 * volume (through the master) and any ad hold; a screen that has already had its fanfare is not
 * given a second one. A context the OS or the browser still holds suspended is resumed best-effort
 * — the voice is scheduled on the graph and simply starts once the context runs.
 */
export function playVictoryFanfare(): void {
  const e = engine;
  if (victoryPlayed || victorySrc || !e) return;
  if (!settings.sound || adHold) return;
  const buf = victoryBuffer;
  if (!buf) return;                    // still decoding: a late fanfare is worse than none
  const { ctx, master } = e;
  if (ctx.state !== 'running') void ctx.resume().catch(() => { /* still locked */ });
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = VICTORY_GAIN;
    src.connect(gain).connect(master);
    src.onended = () => {
      if (victorySrc === src) { victorySrc = null; victoryGain = null; }
      src.disconnect();
      gain.disconnect();
    };
    victorySrc = src;
    victoryGain = gain;
    victoryPlayed = true;
    victoryStartsAt = Math.max(ctx.currentTime, ctx.currentTime + SCHEDULE_LEAD_S - OUTPUT_LATENCY_S);
    src.start(victoryStartsAt);
  } catch {
    victorySrc = null;
    victoryGain = null;
  }
}

/**
 * Hand the fanfare back: a short fade on its own gain, then a hard stop, so leaving the result
 * screen cuts a tail rather than clipping one. A voice that was still ahead of its start time is
 * stopped outright — there is nothing to fade. Idempotent, and it re-arms the next victory.
 */
export function stopVictoryFanfare(): void {
  victoryPlayed = false;
  const src = victorySrc;
  const gain = victoryGain;
  const startsAt = victoryStartsAt;
  victorySrc = null;
  victoryGain = null;
  victoryStartsAt = 0;
  if (!src) return;
  const e = engine;
  if (!e) {
    try { src.stop(); } catch { /* already gone */ }
    return;
  }
  const now = e.ctx.currentTime;
  try {
    if (now < startsAt) {
      src.stop(now);
      return;
    }
    if (gain) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + VICTORY_FADE_S);
    }
    src.stop(now + VICTORY_FADE_S + 0.02);
  } catch {
    try { src.stop(); } catch { /* already gone */ }
  }
}

export const audio = { play, setVolume };
