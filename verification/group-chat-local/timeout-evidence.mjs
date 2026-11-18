import assert from 'node:assert/strict';

// Inspect only the correlated send. HTTP 503 + total duration alone can be an
// Auth failure, and an unrelated request's RPC error is not evidence either.
export function assertRpcLockTimeout(upstream, requestId, minimumMilliseconds = 4500) {
  const steps = upstream.filter(row => row.request_id === requestId);
  for (const stage of ['auth', 'membership']) {
    const rows = steps.filter(row => row.stage === stage);
    assert.ok(rows.length && rows.every(row => row.http_status === 200 && !row.error_type), `${stage} must succeed before RPC timeout`);
  }
  const rpc = steps.filter(row => row.stage === 'rpc');
  assert.equal(rpc.length, 1, 'Expected exactly one send RPC attempt');
  assert.equal(rpc[0].operation, 'chat_send_message');
  assert.ok(rpc[0].elapsed_ms >= minimumMilliseconds, 'Send RPC did not reach the lock timeout interval');
  assert.ok(rpc[0].db_error_code === '55P03' || rpc[0].error_type === 'AbortError' || rpc[0].error_type === 'TimeoutError',
    'Expected a PostgreSQL lock timeout or upstream RPC timeout');
}
