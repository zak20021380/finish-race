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
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
