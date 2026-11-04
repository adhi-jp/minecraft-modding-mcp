/** Raised by `withDeadline` when `ms` passes before the promise settles. */
export class DeadlineExceededError extends Error {
  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`);
  }
}

/**
 * Settles like `promise`, or rejects with `DeadlineExceededError` once `ms`
 * passes first. The timer is cleared on either settlement and unref'd, so it
 * never keeps the process alive; the promise itself keeps running.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineExceededError(ms)), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
