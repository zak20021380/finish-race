/**
 * audio.ts — the race's sound engine. One `AudioContext`, six decoded assets (`log.mp3`,
 * `move.wav`, `explosion.mp3`, `laugh.mp3`, `angry.wav`, `swoosh.mp3`) and one master gain: every voice is a `BufferSource` on the graph,
 * scheduled against the context clock so a step, a wall or a blast lands on the frame that caused it
 * rather than the frame after.
 *
 * The context is built at startup and the decodes start with it, but a mobile webview keeps it
 * suspended and silent until the page has been touched: the first `pointerdown` (the Play tap
 * included) resumes it, and `play` is a no-op until then. Nothing here is allowed to throw, block
 * or leak into gameplay.
 */
import { onSettings, settings } from './settings';
import logMp3 from './assets/sounds/log.mp3';
import moveWav from './assets/sounds/move.wav';
import explosionMp3 from './assets/sounds/explosion.mp3';
import laughMp3 from './assets/sounds/laugh.mp3';
import angryWav from './assets/sounds/angry.wav';
import swooshMp3 from './assets/sounds/swoosh.mp3';

export type SoundName = 'log' | 'move' | 'explosion' | 'laugh' | 'angry' | 'swoosh';

/**
 * How far ahead of `currentTime` an immediate play is scheduled: enough for the node graph to be
 * built and handed to the render thread before its start time arrives, so the first sample is never
 * clipped.
 */
const SCHEDULE_LEAD_S = 0.03;

/** Fast moves must not machine-gun: `move.wav` is limited to one play per this many milliseconds. */
const MOVE_GAP_MS = 40;

/** A ball shoved down the board by the log slides at this playback rate. */
export const SHOVE_RATE = 0.7;

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

/** The amplitude above which a sample of `log.mp3` counts as sound, when its lead-in is measured. */
const TRIM_EPS = 1e-3;

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

/**
 * The silent lead-in measured off `log.mp3` the moment it finishes decoding — the log's roll starts
 * on the frame its first sample is audible, so playback starts this far into the buffer.
 */
export let LOG_TRIM_S = 0;

/**
 * The context's own output latency, read when the context starts running and subtracted from every
 * start time so the sound leaves the speaker with the frame, not a headset's worth of milliseconds
 * after it. 0 when the browser does not report one.
 */
export let OUTPUT_LATENCY_S = 0;

function measureTrim(buf: AudioBuffer): number {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buf.numberOfChannels; ch++) channels.push(buf.getChannelData(ch));
  for (let i = 0; i < buf.length; i++) {
    for (const data of channels) if (Math.abs(data[i]) > TRIM_EPS) return i / buf.sampleRate;
  }
  return 0;                  // an all-silent file is played as-is rather than muted entirely
}

function readLatency(ctx: AudioContext): number {
  try {
    const v = ctx.outputLatency;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

function decode(name: SoundName, url: string): void {
  const e = engine;
  if (!e) return;
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    })
    .then((raw) => e.ctx.decodeAudioData(raw))
    .then((buf) => {
      buffers[name] = buf;
      if (name === 'log') LOG_TRIM_S = measureTrim(buf);
    })
    .catch(() => { /* a missing or undecodable asset is a silent voice, never a broken game */ });
}

decode('log', logMp3);
decode('move', moveWav);
decode('explosion', explosionMp3);
decode('laugh', laughMp3);
decode('angry', angryWav);
decode('swoosh', swooshMp3);

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

function applyGain(): void {
  if (engine) engine.master.gain.value = settings.sound ? volume : 0;
}
applyGain();
onSettings(applyGain);       // the Sound row in Settings mutes the whole engine, instantly

/** Set the engine's volume (0..1), persisted for the next visit. */
export function setVolume(v: number): void {
  volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  try { window.localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* stay in memory */ }
  applyGain();
}

/* ---------- the voices ---------- */

export interface PlayOptions {
  /**
   * The `performance.now()` frame this sound belongs to. Omitted for a play computed on the spot;
   * given for the log, whose roll is scheduled `LOG_ALERT_MS` ahead of the handler that starts it.
   */
  at?: number;
  /** The buffer's playback rate, e.g. `SHOVE_RATE` for a ball the log is pushing. */
  rate?: number;
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
  if (!unlocked || !settings.sound || !e) return;
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
  const delay = opts.at === undefined ? 0 : Math.max(0, (opts.at - performance.now()) / 1000);
  const cue = opts.at === undefined ? SCHEDULE_LEAD_S : delay;
  const when = Math.max(ctx.currentTime, ctx.currentTime + cue - OUTPUT_LATENCY_S);
  try {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (opts.rate !== undefined) src.playbackRate.value = opts.rate;
    let voice: GainNode | null = null;
    if (opts.gain !== undefined && opts.gain !== 1) {
      voice = ctx.createGain();
      voice.gain.value = Math.min(1, Math.max(0, opts.gain));
      src.connect(voice).connect(master);
    } else src.connect(master);
    src.onended = () => { src.disconnect(); voice?.disconnect(); };
    src.start(when, name === 'log' ? LOG_TRIM_S : 0);
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

export const audio = { play, setVolume };
