import assert from 'node:assert/strict';
import { it } from 'node:test';
import { loadSource } from './helpers/load-source';
import { setImmediate } from 'node:timers/promises';
import { createExtendClient, createFreeEndActionHandler, type ExtendFreeResult } from '../lib/free-end-action';

for (const platform of ['ios', 'android', 'web']) {
  it(`registers the extension action for ${platform}`, async () => {
    const categories: { actions: { options: { opensAppToForeground: boolean } }[] }[] = [];
    const module = loadSource<{ registerNotificationCategories(): Promise<void> }>('lib/push-notifications.ts', {
      'expo-constants': {}, 'expo-device': {},
      'expo-notifications': {
        setNotificationHandler() {},
        async setNotificationCategoryAsync(_id: string, actions: typeof categories[number]['actions']) {
          categories.push({ actions });
        },
      },
      'react-native': { Platform: { OS: platform } },
      './free-end-action': { EXTEND_30_ACTION: 'extend_30', FREE_END_CATEGORY: 'free_end' },
      './supabase': {},
    });
    await module.registerNotificationCategories();
    assert.equal(categories.length, platform === 'web' ? 0 : 1);
    if (platform !== 'web') {
      assert.equal(categories[0].actions[0].options.opensAppToForeground, platform === 'ios');
    }
  });
}

for (const timing of ['simultaneous', 'after-completion']) {
  it(`handles iOS launch and listener responses ${timing} without extending twice`, async () => {
    const response = { actionIdentifier: 'extend_30', notification: {
      request: { identifier: 'ios-launch-1', content: { data: { type: 'free_end', notificationId: 'claim-1' } } },
    } };
    let last: typeof response | null = response;
    let listener!: (event: typeof response) => void;
    let until = Date.parse('2026-11-17T12:00:00Z');
    const originalUntil = until;
    let requests = 0;
    let clears = 0;
    const client = createExtendClient({ apiUrl: 'https://api.example.test',
      getAccessToken: async () => 'session-token', onChanged() {},
      fetch: async (_url, init) => {
        assert.deepEqual(JSON.parse(init?.body as string), { claim_id: 'claim-1' });
        requests += 1;
        // The DB enforces this claim/free_until match, including across JS runtimes.
        if (until !== originalUntil) return new Response(null, { status: 409 });
        until += 30 * 60_000;
        return Response.json({ is_free: true, free_until: new Date(until).toISOString() });
      },
    });
    const handleFreeEndAction = createFreeEndActionHandler(id =>
      client('/profiles/me/is-free/extend-from-notification', { claim_id: id }));
    const effects: (() => void | (() => void))[] = [];
    let stateIndex = 0;
    const state = [{ user: { id: 'self' } }, false, { userId: 'self', revision: 0 }];
    const react = { useState: () => [state[stateIndex++], () => {}],
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useEffect(effect: typeof effects[number]) { effects.push(effect); }, createElement() { return null; } };
    const root = loadSource<{ default(): void }>('app/_layout.tsx', {
      '@/lib/push-notifications': {}, '@supabase/supabase-js': {},
      'expo-notifications': {
        async getLastNotificationResponseAsync() { return last; },
        async clearLastNotificationResponseAsync() { last = null; clears += 1; },
        addNotificationResponseReceivedListener(callback: typeof listener) {
          listener = callback; return { remove() {} };
        },
      },
      'expo-router': { Stack: { Protected: 'protected' } }, 'expo-status-bar': {}, react,
      'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value: unknown) => value } },
      'react-native-reanimated': {}, '@/components/themed-text': {}, '@/components/themed-view': {},
      '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
      '@/lib/notification-task': { handleFreeEndAction }, '@/lib/supabase': {},
      '@/lib/logout': { logoutFlow: { revision: () => 0, isBlocked: () => false,
        isAuthenticating: () => false, getError: () => null } },
      '@/lib/session-identity': { jwtSessionId: () => 'test-session' },
    }, { React: react });
    root.default();
    // Exercise the actual root effect that installs the listener and reads the launch response.
    const cleanup = effects[3]();
    try {
      if (timing === 'after-completion') await setImmediate();
      listener(response);
      await setImmediate();
      assert.equal(until - originalUntil, 30 * 60_000);
      assert.equal(requests, timing === 'simultaneous' ? 1 : 2);
      assert.equal(last, null);
      assert.ok(clears >= 1);
    } finally { if (typeof cleanup === 'function') cleanup(); }
  });
}

it('keeps sign-in mounted and gates authenticated screens until preparation succeeds', () => {
  const session = { user: { id: 'self' } };
  for (const [current, authenticating, prepared, expected] of [
    [null, true, false, true],
    [session, true, false, false],
    [session, false, false, false],
    [session, false, true, true],
  ] as const) {
    let slot = 0;
    let stackMounted = false;
    const checked = prepared ? { identity: 'self:test-session', revision: 1 } : { identity: null, revision: 0 };
    const states = [current, false, checked, false, 0];
    const Stack = { Protected: 'protected', Screen: 'screen' };
    const react = {
      useState: () => [states[slot++], () => {}],
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
      useEffect() {},
      createElement(type: unknown) { stackMounted ||= type === Stack; },
    };
    const root = loadSource<{ default(): void }>('app/_layout.tsx', {
      react, 'expo-router': { Stack }, 'expo-notifications': {}, 'expo-status-bar': {},
      'react-native': { StyleSheet: { create: (value: unknown) => value } }, 'react-native-reanimated': {},
      '@/lib/push-notifications': {}, '@/lib/supabase': { supabase: {} }, '@/lib/notification-task': {},
      '@/lib/session-identity': { jwtSessionId: () => 'test-session' },
      '@/lib/logout': { logoutFlow: { revision: () => 1, isBlocked: () => false,
        isAuthenticating: () => authenticating, getError: () => null } },
      '@/components/themed-text': {}, '@/components/themed-view': {},
      '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    }, { React: react });
    root.default();
    assert.equal(stackMounted, expected);
  }
});

for (const result of [
  { ok: true, freeUntil: '2026-11-17T12:00:00.000Z' },
  { ok: false, reason: 'conflict' },
  { ok: false, reason: 'server-error' },
  { ok: false, reason: 'not-authenticated' },
] as const) {
  it(`reports ${result.ok ? 'success' : result.reason} appropriately from the background task`, async () => {
    let task!: (event: { data: unknown }) => Promise<string>;
    const bodies: string[] = [];
    loadSource('lib/notification-task.ts', {
      'expo-notifications': {
        BackgroundNotificationTaskResult: { NewData: 'new', NoData: 'none', Failed: 'failed' },
        async registerTaskAsync() {},
        async scheduleNotificationAsync(input: { content: { body: string } }) { bodies.push(input.content.body); },
      },
      'expo-task-manager': { defineTask(_name: string, handler: typeof task) { task = handler; } },
      'react-native': { Platform: { OS: 'android' } },
      './extend-free': { extendFreeFromNotification: async (): Promise<ExtendFreeResult> => result },
      './free-end-action': { createFreeEndActionHandler },
    });
    const outcome = await task({ data: {
      actionIdentifier: 'extend_30',
      notification: { request: { content: { data: { type: 'free_end', notificationId: 'claim-1' } } } },
    } });
    assert.equal(outcome, result.ok ? 'new' : result.reason === 'server-error' ? 'failed' : 'none');
    if (!result.ok && result.reason === 'not-authenticated') {
      assert.deepEqual(bodies, []);
      return;
    }
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0], result.ok ? '暇状態を30分延長しました。' : result.reason === 'conflict'
      ? 'アプリを開いて現在の暇状態を確認してください。'
      : '延長できませんでした。アプリを開いて確認してください。');
  });
}
