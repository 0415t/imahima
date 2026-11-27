import { disabledTimerDependencies } from '../../tests/helpers/chat-availability';
// Test entrypoint using the real routers/services. No dotenv or Push worker imports.
import assert from 'node:assert/strict';
import { createApp } from '../../server/app';
import { groupService } from '../../server/services/groups';
import { chatService } from '../../server/services/chat';

async function main() {
  assert.equal(process.env.SUPABASE_URL, 'http://127.0.0.1:56321');
  assert.equal(process.env.CHAT_LOCAL_PROJECT_ID, 'imahima-chat-local');
  assert.equal(process.env.PORT, '56331');
  assert.ok(process.env.CHAT_INTEGRATION_RUN);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== 'http://127.0.0.1:56321') throw new Error('Nonlocal API access blocked');
    const response = await nativeFetch(input, { ...init, redirect: 'error' });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      let rpcStatus: number | null = null;
      try { const data = await response.clone().json(); if (typeof data.status === 'number') rpcStatus = data.status; } catch { /* No response body logging. */ }
      process.send?.({ type: 'rpc', name: url.pathname.split('/').at(-1), http_status: response.status, rpc_status: rpcStatus, observed_at: new Date().toISOString() });
    }
    return response;
  };
  const { serverSupabase } = await import('../../server/services/supabase.js');
  const getUserId = async (token: string) => {
    const { data, error } = await serverSupabase.auth.getUser(token);
    return { userId: data.user?.id ?? null, error };
  };
  const groups = groupService(serverSupabase, getUserId);
  const app = createApp({ ...disabledTimerDependencies, getUserId, toggleIsFree: async () => { throw new Error('Availability mutations disabled in chat verification'); } }, groups, chatService(serverSupabase, groups));
  const server = app.listen(56331, '127.0.0.1', () => {
    process.send?.({ type: 'ready', project: 'imahima-chat-local', run: process.env.CHAT_INTEGRATION_RUN });
  });
  server.on('error', () => { process.send?.({ type: 'fatal', code: 'LOCAL_LISTENER_FAILED' }); process.exit(1); });
  process.on('message', message => { if (message === 'stop') { server.close(() => process.exit(0)); server.closeAllConnections(); } });
}
process.on('uncaughtException', () => { process.send?.({ type: 'fatal', code: 'LOCAL_API_EXCEPTION' }); process.exit(1); });
process.on('unhandledRejection', () => { process.send?.({ type: 'fatal', code: 'LOCAL_API_REJECTION' }); process.exit(1); });
void main();
