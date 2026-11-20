// Test-only barrier: a swallowed worker error must not leave top-level await
// pending forever and bypass the fixture's finally/DB shutdown.
export async function waitForWorkerBarrier(ready: Promise<void>, run: Promise<void>, timeoutMs = 10_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      run.then(() => { throw new Error('Worker completed before entering send'); }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Worker send barrier timed out')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
