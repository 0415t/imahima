import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';

export const TIMEOUTS = { auth: 5_000, postgrest: 8_000, request: 20_000 } as const;
const requests = new AsyncLocalStorage<AbortSignal>();
const cancelled = () => new DOMException('Operation cancelled', 'AbortError');

// Racing bounds even a dependency that ignores cancellation. It does not undo
// upstream work. The losing promise remains observed to avoid late rejections.
export async function abortable<T>(work: () => PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

export function requestStep<T>(work: () => PromiseLike<T>): Promise<T> {
  const signal = requests.getStore();
  return signal ? abortable(work, signal) : Promise.resolve().then(work);
}

export function requestDeadline(milliseconds: number = TIMEOUTS.request): RequestHandler {
  return (req, res, next) => {
    if (!/^\/groups(?:\/|$)/i.test(req.path)) { next(); return; }
    const chat = /^\/groups\/[^/]+\/(?:messages|message-events)(?:\/|$)/i.test(req.path);
    const controller = new AbortController();
    const stop = () => controller.abort(cancelled());
    const timer = setTimeout(() => {
      stop();
      if (res.headersSent || res.destroyed) return;
      res.set('Cache-Control', 'no-store').status(503).json(chat
        ? { error: 'Chat service unavailable', code: 'CHAT_UNAVAILABLE' }
        : { error: 'Group service unavailable' });
    }, milliseconds);
    const cleanup = () => { clearTimeout(timer); stop(); req.off('aborted', stop); };
    req.once('aborted', stop);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    requests.run(controller.signal, next);
  };
}

export function timeoutFetch(fetcher: typeof fetch = globalThis.fetch,
  limits: { auth: number; postgrest: number } = TIMEOUTS): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(cancelled()), url.pathname.startsWith('/auth/v1/') ? limits.auth : limits.postgrest);
    const signals = [controller.signal, requests.getStore(), init?.signal,
      typeof input === 'object' && !(input instanceof URL) ? input.signal : undefined]
      .filter((s): s is AbortSignal => !!s);
    const signal = AbortSignal.any(signals);
    try {
      return await abortable(async () => {
        const response = await fetcher(input, { ...init, signal });
        // Keep the deadline through response-body consumption, not just headers.
        const body = await response.arrayBuffer();
        return new Response([204, 205, 304].includes(response.status) ? null : body,
          { status: response.status, statusText: response.statusText, headers: response.headers });
      }, signal);
    } finally { clearTimeout(timer); }
  };
}
