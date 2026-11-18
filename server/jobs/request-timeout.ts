// Bound the wait even if an injected dependency ignores AbortSignal. Real transports
// must also consume the signal so a timed-out operation cannot keep sending later.
export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort(new Error('Notification request aborted or timed out'));
    rejectAbort(controller.signal.reason);
  };
  const timer = setTimeout(abort, timeoutMs);
  parent?.addEventListener('abort', abort, { once: true });
  try {
    if (parent?.aborted) abort();
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abort);
  }
}
