/**
 * Minimal concurrency limiter — no dependency, just a semaphore over an async
 * queue. Kept deliberately tiny rather than pulling in p-limit: this is the
 * only place run.mts needs one.
 */
export function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const run = queue.shift();
    run?.();
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}
