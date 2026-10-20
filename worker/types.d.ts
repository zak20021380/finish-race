/**
 * types.d.ts — the slice of the Cloudflare Workers runtime this backend touches.
 *
 * The worker is deliberately dependency-free: no `@cloudflare/workers-types`, no runtime
 * packages. Only the handful of globals actually used are declared here, so the same `tsc`
 * that checks the client also checks the worker (see `worker/tsconfig.json`). The rest —
 * `Request`, `Response`, `Headers`, `crypto.subtle`, `URL` — comes from the standard library.
 */

/** The server half of a pair can accept; the client half has no such call. */
interface WebSocket {
  accept(): void;
}

/** `new Response(null, { status: 101, webSocket: client })` is how an upgrade is answered. */
interface ResponseInit {
  webSocket?: WebSocket;
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  acceptWebSocket(socket: WebSocket): void;
  getWebSockets(): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  /**
   * The object's own clock and its key/value store. A multi-seat room holds its seats open for a
   * short wait and then fills them with bots; the wait rides on this alarm rather than on a timer,
   * because a Durable Object may be evicted between messages and an alarm is the one thing that
   * survives that. The store is where the Command Center's player directory is kept, so the
   * registry outlives an eviction. Optional here because the test harness drives the object
   * without a storage backend.
   */
  readonly storage?: {
    setAlarm(scheduledTime: number): void;
    deleteAlarm(): void;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    /** The entries form is one atomic write: a counter and its claim land together, or not at all. */
    put(entries: Record<string, unknown>): Promise<void>;
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
