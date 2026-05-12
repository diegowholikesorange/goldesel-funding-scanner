/**
 * Runs tasks with a bounded concurrency limit.
 * minIntervalMs, if set, enforces a minimum delay between consecutive task starts
 * to avoid bursting past exchange raw-request rate limits.
 * Each task handles its own errors internally.
 */
export async function runCapped(
  tasks: Array<() => Promise<void>>,
  limit: number,
  minIntervalMs = 0,
): Promise<void> {
  let i = 0;
  let lastStartMs = 0;

  async function worker() {
    while (i < tasks.length) {
      if (minIntervalMs > 0) {
        const elapsed = Date.now() - lastStartMs;
        if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
      }
      lastStartMs = Date.now();
      const task = tasks[i++];
      await task().catch(() => {/* task handles its own errors */});
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
