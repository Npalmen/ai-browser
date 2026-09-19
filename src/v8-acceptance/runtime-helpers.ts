export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15000,
  message = 'Timed out waiting for acceptance condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const extra = last instanceof Error ? ` (${last.message})` : '';
  throw new Error(`${message}${extra}`);
}

export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
