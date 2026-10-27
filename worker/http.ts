/** Every non-upgrade route answers with one of these. `headers` may override the defaults. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/**
 * The shortest honest description of a caught failure, fit to travel in a JSON body. A route that
 * swallows an error and answers a bare status is how a live backend ends up reported as offline.
 * The message only, never a stack: these bodies reach the operator's browser.
 */
export function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}
