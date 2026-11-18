// Local integration entrypoint: real routes/Auth/RPC, no push service or worker imports.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createApp } from './app';

assert.equal(process.env.FREE_END_NOTIFICATIONS_ENABLED, 'false');
assert.equal(process.env.MEMBER_FREE_NOTIFICATIONS_ENABLED, 'false');
const config = JSON.parse(readFileSync('.env.member-free-api.local', 'utf8'));
assert.equal(config.url, 'http://127.0.0.1:55440');
assert.equal(config.api, 'http://127.0.0.1:55441');
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, config.url, 'Local API outbound HTTP must use the dedicated gateway');
  return originalFetch(input, init);
};
const client = createClient(config.url, config.service, {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  const row = Array.isArray(data) ? data[0] : data;
  return { isFree: row?.is_free ?? null, freeUntil: row?.free_until ?? null, error };
}
const app = createApp({
  getUserId: async (token) => {
    const { data, error } = await client.auth.getUser(token);
    return { userId: data.user?.id ?? null, error };
  },
  toggleIsFree: async (userId) => {
    const { data, error } = await client.rpc('toggle_profile_is_free', { target_profile_id: userId });
    return { isFree: data, error };
  },
  setIsFree: (userId, isFree, minutes) => rpc('set_profile_is_free', {
    target_profile_id: userId, new_is_free: isFree, duration_minutes: minutes ?? null,
  }),
  extendIsFree: (userId) => rpc('extend_profile_is_free', { target_profile_id: userId }),
  extendIsFreeFromNotification: (userId, claimId) => rpc('extend_profile_is_free_from_notification', {
    target_profile_id: userId, claim_id: claimId,
  }),
}); // notifications omitted: manual push endpoint returns 503.
app.listen(55441, '127.0.0.1', () => console.log('Dedicated local API: 127.0.0.1:55441; push disabled'));
