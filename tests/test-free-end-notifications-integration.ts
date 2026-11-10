/**
 * 終了5分前通知ポーラーの統合テスト
 * 実ローカルSupabase（REST API経由）+ Expo Pushモックを使用
 *
 * 実行方法:
 *   node --env-file=.env.test --import tsx tests/test-free-end-notifications-integration.ts
 * 前提:
 *   - imahima専用ローカルSupabaseが起動していること
 *   - .env.test に SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていること
 *   - Expo Push APIはモック（実送信しない）
 *
 * 安全チェック:
 *   - SUPABASE_URL が 127.0.0.1 / localhost のローカルSupabase以外を指す場合は、
 *     DB操作を一切行わず即座にエラー終了する
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  createFreeEndNotificationPoller,
  type FreeEndNotificationClaim,
  type FreeEndNotificationValidation,
} from '../server/jobs/free-end-notifications';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.test');
}

// 接続先がimahima専用ローカルSupabase（127.0.0.1 / localhost、ポート55321）以外の場合は即座に終了
// キーの値はログに表示しない
const EXPECTED_LOCAL_PORT = '55321';

function assertLocalSupabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SUPABASE_URL is not a valid URL. Aborting before any DB operation.');
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLocalHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  if (!isLocalHost) {
    throw new Error(
      'SUPABASE_URL must point to a local Supabase (127.0.0.1 / localhost). ' +
        'Aborting before any DB operation to avoid modifying a non-local database.'
    );
  }
  if (parsed.port !== EXPECTED_LOCAL_PORT) {
    throw new Error(
      `SUPABASE_URL must use port ${EXPECTED_LOCAL_PORT} (imahima local Supabase). ` +
        'Aborting before any DB operation.'
    );
  }
}

assertLocalSupabaseUrl(SUPABASE_URL);

const supabase: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// テスト用ユーザーのメールアドレス（IDは作成後に取得する）
const EMAIL_A = 'user-a@example.com';
const EMAIL_B = 'user-b@example.com';
const EMAIL_C = 'user-c@example.com';
const EMAIL_D = 'user-d@example.com';
const EMAIL_E = 'user-e@example.com';
const ALL_EMAILS = [EMAIL_A, EMAIL_B, EMAIL_C, EMAIL_D, EMAIL_E, 'user-f@example.com', 'user-g@example.com'];

type SendCall = { tokens: string[]; message: { title: string; body: string; data?: Record<string, unknown> } };

let sendCalls: SendCall[] = [];
let sendShouldFail = false;

function buildPollerDependencies() {
  return {
    claimNotifications: async () => {
      const { data, error } = await supabase.rpc('claim_free_end_notifications');
      const rows = (data ?? []) as Record<string, unknown>[];
      const claims: FreeEndNotificationClaim[] = rows.map((row) => ({
        claimId: String(row.claim_id),
        userId: String(row.user_id),
        freeUntil: String(row.free_until),
        attempts: Number(row.attempts),
        leaseToken: String(row.lease_token),
        leaseExpiresAt: String(row.lease_expires_at),
      }));
      return { claims, error };
    },
    validateNotification: async (claimId: string, leaseToken: string) => {
      const { data, error } = await supabase.rpc('validate_free_end_notification', {
        p_claim_id: claimId,
        p_lease_token: leaseToken,
      });
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
      const validation: FreeEndNotificationValidation | null = row
        ? { owned: Boolean(row.owned), stillValid: Boolean(row.still_valid) }
        : null;
      return { validation, error };
    },
    getDeviceTokens: async (userId: string) => {
      const { data, error } = await supabase
        .from('user_device_tokens')
        .select('expo_push_token')
        .eq('user_id', userId);
      return { tokens: (data ?? []).map((row) => row.expo_push_token), error };
    },
    // Expo Push APIのモック（実送信しない）
    sendPushNotifications: async (
      tokens: string[],
      message: { title: string; body: string; data?: Record<string, unknown> }
    ) => {
      sendCalls.push({ tokens, message });
      if (sendShouldFail) {
        return { sent: 0, error: new Error('expo unavailable (mock)') };
      }
      return { sent: tokens.length, error: null };
    },
    completeNotification: async (
      claimId: string,
      leaseToken: string,
      status: 'sent' | 'failed' | 'cancelled',
      errorMessage?: string
    ) => {
      const { data, error } = await supabase.rpc('complete_free_end_notification', {
        p_claim_id: claimId,
        p_lease_token: leaseToken,
        p_status: status,
        p_error: errorMessage ?? null,
      });
      return { completed: data === true, error };
    },
  };
}

async function cleanup() {
  const { data: listData } = await supabase.auth.admin.listUsers();
  const testUsers = (listData?.users ?? []).filter((u) => ALL_EMAILS.includes(u.email ?? ''));
  for (const user of testUsers) {
    await supabase.from('free_end_notification_claims').delete().eq('user_id', user.id);
    await supabase.from('user_device_tokens').delete().eq('user_id', user.id);
    await supabase.from('profiles').delete().eq('id', user.id);
    await supabase.auth.admin.deleteUser(user.id).catch(() => {});
  }
}

async function createUserWithProfile(
  email: string,
  isFree: boolean,
  freeUntil: Date | null
): Promise<string> {
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password: 'test-password-123',
    email_confirm: true,
    user_metadata: { username: email.split('@')[0] },
  });
  if (authError || !authData.user) {
    throw new Error(`createUser failed (${email}): ${authError?.message}`);
  }
  const userId = authData.user.id;
  const { error: updateError } = await supabase
    .from('profiles')
    .update({
      is_free: isFree,
      free_until: freeUntil ? freeUntil.toISOString() : null,
    })
    .eq('id', userId);
  if (updateError) {
    throw new Error(`profiles update failed (${email}): ${updateError.message}`);
  }
  return userId;
}

async function addDeviceToken(userId: string, token: string) {
  const { error } = await supabase.from('user_device_tokens').insert({
    user_id: userId,
    expo_push_token: token,
    platform: 'ios',
  });
  if (error) {
    throw new Error(`token insert failed: ${error.message}`);
  }
}

async function getClaim(userId: string) {
  const { data } = await supabase
    .from('free_end_notification_claims')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`ASSERT FAILED: ${message}`);
  }
}

async function run() {
  console.log('START integration test (local Supabase + Expo Push mock)\n');

  await cleanup();
  console.log('cleanup done');

  const now = Date.now();
  const in4min = new Date(now + 4 * 60 * 1000);
  const expired = new Date(now - 60 * 1000);

  const userA = await createUserWithProfile(EMAIL_A, true, in4min);
  const userB = await createUserWithProfile(EMAIL_B, true, in4min);
  const userC = await createUserWithProfile(EMAIL_C, true, in4min);
  const userD = await createUserWithProfile(EMAIL_D, true, expired);
  const userE = await createUserWithProfile(EMAIL_E, true, null);
  await addDeviceToken(userA, 'ExponentPushToken[device-a]');
  await addDeviceToken(userB, 'ExponentPushToken[device-b]');
  await addDeviceToken(userC, 'ExponentPushToken[device-c]');
  console.log('test data created (5 users, 3 tokens)\n');

  const poller = createFreeEndNotificationPoller(buildPollerDependencies());

  // Test 1: extract targets and send
  console.log('TEST 1: extract targets and send');
  sendCalls = [];
  await poller.runOnce();

  assert(sendCalls.length === 3, `expected 3 sends, got ${sendCalls.length}`);
  const sentTokens = sendCalls.map((c) => c.tokens[0]);
  assert(sentTokens.includes('ExponentPushToken[device-a]'), 'userA not sent');
  assert(sentTokens.includes('ExponentPushToken[device-b]'), 'userB not sent');
  assert(sentTokens.includes('ExponentPushToken[device-c]'), 'userC not sent');
  assert(!sentTokens.includes('ExponentPushToken[device-d]'), 'userD (expired) should not be sent');
  assert(!sentTokens.includes('ExponentPushToken[device-e]'), 'userE (unlimited) should not be sent');

  const claimsA = await getClaim(userA);
  assert(claimsA.length === 1 && claimsA[0].status === 'sent', `userA claim not sent: ${claimsA[0]?.status}`);
  assert(claimsA[0].sent_at !== null, 'userA sent_at not recorded');
  console.log('PASS test 1: extract, send, complete\n');

  // Test 2: duplicate prevention
  console.log('TEST 2: duplicate prevention');
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 0, `second run sent: ${sendCalls.length}`);
  const claimsA2 = await getClaim(userA);
  assert(claimsA2.length === 1, `userA claim duplicated: ${claimsA2.length}`);
  console.log('PASS test 2: duplicate prevention\n');

  // Test 3: manual OFF before claim -> not sent
  console.log('TEST 3: manual OFF before claim -> not sent');
  await supabase.from('profiles').update({ is_free: false, free_until: null }).eq('id', userC);
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 0, `sent after manual OFF: ${sendCalls.length}`);
  const claimsC = await getClaim(userC);
  const activeClaimsC = claimsC.filter((c) => c.status !== 'cancelled' && c.status !== 'sent');
  assert(activeClaimsC.length === 0, `userC active claim should not exist: ${activeClaimsC.length}`);
  console.log('PASS test 3: manual OFF before claim not sent\n');

  // Test 3b: manual OFF after claim -> cancelled
  console.log('TEST 3b: manual OFF after claim -> cancelled');
  const in4minC = new Date(Date.now() + 4 * 60 * 1000);
  await supabase.from('profiles').update({ is_free: true, free_until: in4minC.toISOString() }).eq('id', userC);
  // claim only (no send) to create a pending/processing claim
  const { data: claimedC } = await supabase.rpc('claim_free_end_notifications');
  const claimC = (claimedC ?? []).find((r: Record<string, unknown>) => r.user_id === userC);
  assert(claimC !== undefined, 'userC claim not claimed');
  // manual OFF after claim
  await supabase.from('profiles').update({ is_free: false, free_until: null }).eq('id', userC);
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 0, `sent after manual OFF (claimed): ${sendCalls.length}`);
  const claimsC2 = await getClaim(userC);
  const cancelledC = claimsC2.find((c) => c.id === claimC.claim_id);
  assert(cancelledC?.status === 'cancelled', `userC claim not cancelled: ${cancelledC?.status}`);
  console.log('PASS test 3b: manual OFF after claim cancelled\n');

  // Test 4: re-notify after extension
  console.log('TEST 4: re-notify after extension');
  const { data: profileB, error: profileBError } = await supabase
    .from('profiles')
    .select('free_until')
    .eq('id', userB)
    .single();
  if (profileBError || !profileB || typeof profileB.free_until !== 'string') {
    throw new Error(`Unable to read userB free_until: ${profileBError?.message ?? 'missing free_until'}`);
  }
  const extendedUntil = new Date(new Date(profileB.free_until).getTime() + 30 * 60 * 1000);
  await supabase.from('profiles').update({ free_until: extendedUntil.toISOString() }).eq('id', userB);
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 0, `sent right after extension (out of window): ${sendCalls.length}`);
  const claimsB = await getClaim(userB);
  const oldClaimB = claimsB.find((c) => c.status === 'sent');
  assert(oldClaimB !== undefined, 'userB old (sent) claim not found');
  // sent claim remains as history; no new claim is created while out of window
  const newClaimsB = claimsB.filter((c) => c.id !== oldClaimB.id);
  assert(newClaimsB.length === 0, `userB new claim should not exist yet: ${newClaimsB.length}`);

  const newIn4min = new Date(Date.now() + 4 * 60 * 1000);
  await supabase.from('profiles').update({ free_until: newIn4min.toISOString() }).eq('id', userB);
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 1, `re-notify after extension not sent: ${sendCalls.length}`);
  assert(sendCalls[0].tokens[0] === 'ExponentPushToken[device-b]', 're-notify not for userB');
  console.log('PASS test 4: re-notify after extension\n');

  // Test 5: send failure and retry
  console.log('TEST 5: send failure and retry');
  const newIn4minA = new Date(Date.now() + 4 * 60 * 1000);
  await supabase.from('profiles').update({ is_free: true, free_until: newIn4minA.toISOString() }).eq('id', userA);

  sendShouldFail = true;
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 1, `failure test did not attempt send: ${sendCalls.length}`);
  const claimsA3 = await getClaim(userA);
  const failedClaim = claimsA3.find((c) => c.status === 'failed');
  assert(failedClaim !== undefined, 'userA failed claim not found');
  assert(failedClaim.last_error !== null, 'last_error not recorded');

  sendShouldFail = false;
  sendCalls = [];
  await poller.runOnce();
  assert(sendCalls.length === 1, `retry did not send: ${sendCalls.length}`);
  const claimsA4 = await getClaim(userA);
  const retriedClaim = claimsA4.find((c) => c.id === failedClaim.id);
  assert(retriedClaim?.status === 'sent', `retry status not sent: ${retriedClaim?.status}`);
  assert(retriedClaim.attempts === 2, `attempts not 2: ${retriedClaim?.attempts}`);
  console.log('PASS test 5: send failure and retry\n');

  // Test 6: concurrent execution duplicate prevention (fresh user)
  console.log('TEST 6: concurrent execution duplicate prevention');
  const userF = await createUserWithProfile('user-f@example.com', true, new Date(Date.now() + 4 * 60 * 1000));
  await addDeviceToken(userF, 'ExponentPushToken[device-f]');
  sendCalls = [];
  await Promise.all([poller.runOnce(), poller.runOnce()]);
  const claimsF = await getClaim(userF);
  assert(claimsF.length === 1, `userF claims not 1 (duplicate created): ${claimsF.length}`);
  assert(claimsF[0].status === 'sent', `userF claim not sent: ${claimsF[0].status}`);
  const sendsForF = sendCalls.filter((c) => c.tokens[0] === 'ExponentPushToken[device-f]');
  assert(sendsForF.length === 1, `userF sent not 1: ${sendsForF.length}`);
  console.log('PASS test 6: concurrent duplicate prevention\n');

  // Test 7: lease expiry handling (fresh user)
  console.log('TEST 7: lease expiry handling');
  const userG = await createUserWithProfile('user-g@example.com', true, new Date(Date.now() + 4 * 60 * 1000));
  await addDeviceToken(userG, 'ExponentPushToken[device-g]');
  // claim only (no send) to create a processing claim
  const { data: claimedRows } = await supabase.rpc('claim_free_end_notifications');
  const claimG = (claimedRows ?? []).find((r: Record<string, unknown>) => r.user_id === userG);
  assert(claimG !== undefined, 'userG claim not claimed');
  // expire the lease
  await supabase
    .from('free_end_notification_claims')
    .update({ lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString() })
    .eq('id', claimG.claim_id);
  // poller should re-claim and send
  sendCalls = [];
  await poller.runOnce();
  const sendsForG = sendCalls.filter((c) => c.tokens[0] === 'ExponentPushToken[device-g]');
  assert(sendsForG.length === 1, `lease expiry retry did not send: ${sendsForG.length}`);
  const claimsG = await getClaim(userG);
  const claimG2 = claimsG.find((c) => c.id === claimG.claim_id);
  assert(claimG2?.status === 'sent', `lease expiry retry status not sent: ${claimG2?.status}`);
  assert(claimG2.attempts === 2, `attempts not 2: ${claimG2?.attempts}`);
  console.log('PASS test 7: lease expiry handling\n');

  console.log('ALL INTEGRATION TESTS PASSED');
}

run()
  .catch((error) => {
    console.error('INTEGRATION TEST FAILED:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    console.log('\ncleaning up...');
    await cleanup();
    console.log('cleanup done');
  });
