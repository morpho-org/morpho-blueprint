/**
 * Rejects after `ms` whatever the request does: Next drops a fetch's `signal` when it revalidates a
 * stale cache entry, so the abort signal alone cannot bound an ISR regeneration.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number, source: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
