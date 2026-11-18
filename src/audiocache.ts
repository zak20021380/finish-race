/**
 * audiocache.ts — one fetch and one decode per sound asset, shared by every engine in the app.
 *
 * `audio.ts` and `sound.ts` grew up as two engines with two graphs, and both decoded the same two
 * files (`move.wav`, `explosion.mp3`) into two separate `AudioBuffer`s. The browser's HTTP cache
 * saved the second download only sometimes — a `fetch` with a different init, a private webview
 * cache or a range request all miss — and the decode was always paid twice.
 *
 * So the cache is keyed by URL and owns the only promise for it. Whoever asks first pays; everyone
 * after that gets the same buffer back. A failed asset is remembered as a failure too, so a dead
 * file is not retried on every step of every race.
 *
 * The cache is deliberately free of any graph: it never creates a context, never resumes one and
 * never connects a node. It only turns a URL into an `AudioBuffer`.
 */

/** A decoded buffer, the load in flight, or a failure that has already been paid for. */
interface Entry {
  buffer?: AudioBuffer;
  job?: Promise<AudioBuffer>;
  failed?: boolean;
}

const entries = new Map<string, Entry>();

/** The decoded buffer for `url`, or null while it is still loading (or if it never will). */
export function bufferOf(url: string): AudioBuffer | null {
  return entries.get(url)?.buffer ?? null;
}

/**
 * Decode `url` on `ctx`, once. Every later call for the same URL returns the same promise, so two
 * engines asking at the same instant still produce one fetch and one decode. A rejection is
 * swallowed by the callers, never by this function: an asset that will not decode is a silent
 * voice, and this must not throw into a turn.
 */
export function loadAudio(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const known = entries.get(url);
  if (known?.buffer) return Promise.resolve(known.buffer);
  if (known?.job) return known.job;
  if (known?.failed) return Promise.reject(new Error('cached failure'));

  const entry: Entry = {};
  entries.set(url, entry);
  entry.job = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.arrayBuffer();
    })
    .then((raw) => new Promise<AudioBuffer>((ok, err) => {
      /* the callback form is the one every webview this app runs in actually implements */
      try { ctx.decodeAudioData(raw, ok, err); } catch (e) { err(e as Error); }
    }))
    .then((buffer) => {
      entry.buffer = buffer;
      entry.job = undefined;
      return buffer;
    })
    .catch((e: unknown) => {
      entry.failed = true;
      entry.job = undefined;
      throw e;
    });
  return entry.job;
}

/**
 * Start a batch without waiting for it. The callers are all fire-and-forget by design — a voice
 * that has not decoded yet is dropped, never queued — so a rejection here has no one to tell.
 */
export function primeAudio(ctx: BaseAudioContext, urls: readonly string[]): void {
  for (const url of urls) {
    if (entries.get(url)) continue;
    void loadAudio(ctx, url).catch(() => { /* a silent voice, never a broken game */ });
  }
}
