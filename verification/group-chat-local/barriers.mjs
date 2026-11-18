import { setTimeout as poll } from 'node:timers/promises';

// A completed/failed request is evidence that the expected barrier was missed.
export async function waitForBarrier(barrier, request, label, milliseconds = 5000) {
  let timer;
  try {
    await Promise.race([
      barrier,
      request.then(() => { throw new Error(`${label}: request completed before barrier`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline exceeded`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Follow the blocking chain: a queued operation can wait behind Auth deletion,
// which in turn waits on our room lock. Match the RPC, not just any waiter.
export async function waitForBlockedRpc(db, blockerPid, rpc, request, milliseconds = 4000) {
  const controller = new AbortController();
  const waiting = (async () => {
    while (!controller.signal.aborted) {
      const { rows: [row] } = await db.query(`with recursive blocked(pid) as (
        select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))
        union select a.pid from pg_stat_activity a join blocked b on b.pid=any(pg_blocking_pids(a.pid))
      ) select exists(select 1 from pg_stat_activity a join blocked b using(pid)
        where a.wait_event_type='Lock' and position($2 in a.query)>0) as waiting`, [blockerPid, rpc]);
      if (controller.signal.aborted) return;
      if (row.waiting) return;
      await poll(25, undefined, { signal: controller.signal });
    }
  })();
  try { await waitForBarrier(waiting, request, rpc, milliseconds); }
  finally {
    controller.abort();
    // This connection belongs to the caller. Do not cancel its other work or
    // await an uncooperative query here: return so the caller can roll back its
    // blocker and close its connection. Observe late errors without polling again.
    void waiting.catch(() => {});
  }
}
