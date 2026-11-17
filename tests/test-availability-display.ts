import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import { loadSource } from './helpers/load-source';

function createScreen() {
  let now = Date.parse('2026-11-17T12:00:00Z');
  let fail = false;
  let cursor = 0;
  let dirty = false;
  let writes = 0;
  let refresh!: () => void;
  let cleanup: (() => void) | undefined;
  const states: unknown[] = [];
  const user = { id: 'self', username: 'test', is_free: true, free_until: new Date(now + 60_000).toISOString() };
  type ProfileResult = { user: typeof user; error?: Error };
  let profileResult: Promise<ProfileResult> = Promise.resolve({ user });
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value: unknown) => {
        writes += 1;
        if (!Object.is(states[index], value)) dirty = true;
        states[index] = value;
      }];
    },
    useCallback: (callback: unknown) => callback,
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  };
  const screen = loadSource<{ default(): unknown }>('app/(tabs)/index.tsx', {
    react,
    '@expo/vector-icons/MaterialIcons': {},
    'expo-router': { useFocusEffect(effect: () => () => void) { if (!cleanup) cleanup = effect(); } },
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      StyleSheet: { create: (styles: unknown) => styles }, View: 'view', Pressable: 'button' },
    '@/components/themed-text': { ThemedText: 'text' },
    '@/components/themed-view': { ThemedView: 'view' },
    '@/lib/availability-events': { subscribeAvailabilityChanged: () => () => {} },
    '@/lib/supabase': { hasSupabaseConfig: true, supabase: {
      auth: { async getSession() {
        if (fail) throw new Error('offline');
        return { data: { session: { user: { id: 'self' } } } };
      } },
      from: () => {
        const result = profileResult;
        return { select: () => ({
          limit: async () => { const row = await result; return { data: [row.user], error: row.error }; },
          eq: () => ({ maybeSingle: async () => { const row = await result; return { data: row.user, error: row.error }; } }),
        }) };
      },
    } },
  }, {
    React: react,
    Date: class extends Date { static now() { return now; } },
    setInterval(callback: () => void) { refresh = callback; return 1; }, clearInterval() {},
  });
  const render = () => { cursor = 0; dirty = false; return JSON.stringify(screen.default()); };
  return {
    render,
    refresh: () => refresh(),
    advance: (milliseconds: number) => { now += milliseconds; },
    failAuth: () => { fail = true; },
    unmount: () => { cleanup?.(); },
    get dirty() { return dirty; },
    get writes() { return writes; },
    deferProfiles() {
      const pending = Promise.withResolvers<ProfileResult>();
      profileResult = pending.promise;
      return {
        resolve: (options: { username?: string; error?: Error } = {}) => pending.resolve({
          user: { ...user, username: options.username ?? user.username }, error: options.error,
        }),
        reject: () => pending.reject(new Error('offline')),
      };
    },
  };
}

it('updates expired rows even after repeated fetch failures with unchanged error state', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await setImmediate();
    assert.match(screen.render(), /暇状態: .*ON/);
    screen.failAuth();
    screen.advance(30_000);
    screen.refresh();
    await setImmediate();
    screen.render(); // Error and loading values now match all subsequent failed fetches.
    screen.advance(30_001);
    screen.refresh();
    assert.equal(screen.dirty, true, 'the clock must update before the pending fetch settles');
    await setImmediate();
    assert.equal(screen.dirty, true, 'a failed refresh must still schedule a render');
    const expired = screen.render();
    assert.match(expired, /暇状態: .*OFF/);
    assert.match(expired, /暇状態の取得に失敗しました/);
  } finally { screen.unmount(); }
});

for (const outcome of ['success', 'failure'] as const) {
  it(`updates the expiry clock when a delayed profile request completes with ${outcome}`, async () => {
    const screen = createScreen();
    try {
      screen.render();
      await setImmediate();
      assert.match(screen.render(), /暇状態: .*ON/);
      const pending = screen.deferProfiles();
      screen.advance(10_000);
      screen.refresh();
      await setImmediate();
      screen.advance(60_000); // The cached and fetched profile both expire while awaiting the response.
      pending.resolve(outcome === 'failure' ? { error: new Error('offline') } : {});
      await setImmediate();
      const completed = screen.render();
      assert.match(completed, /暇状態: .*OFF/);
      if (outcome === 'failure') assert.match(completed, /暇状態の取得に失敗しました/);
      else assert.doesNotMatch(completed, /暇状態の取得に失敗しました/);
    } finally { screen.unmount(); }
  });
}

for (const outcome of ['success', 'failure'] as const) {
  it(`ignores an older request completing with ${outcome} after a newer request`, async () => {
    const screen = createScreen();
    try {
      screen.render();
      await setImmediate();
      const older = screen.deferProfiles();
      screen.advance(1_000);
      screen.refresh();
      await setImmediate();
      const newer = screen.deferProfiles();
      screen.advance(1_000);
      screen.refresh();
      await setImmediate();
      newer.resolve({ username: 'latest-profile' });
      await setImmediate();
      assert.match(screen.render(), /latest-profile/);
      const writes = screen.writes;
      screen.advance(70_000);
      if (outcome === 'success') older.resolve({ username: 'obsolete-profile' });
      else older.reject();
      await setImmediate();
      assert.equal(screen.writes, writes, 'obsolete completion must not update any state, including the clock');
      const result = screen.render();
      assert.match(result, /latest-profile/);
      assert.doesNotMatch(result, /obsolete-profile|暇状態の取得に失敗しました/);
    } finally { screen.unmount(); }
  });
}

for (const outcome of ['success', 'failure'] as const) {
  it(`does not update state after unmount when a pending request completes with ${outcome}`, async () => {
    const screen = createScreen();
    const pending = screen.deferProfiles();
    screen.render();
    await setImmediate();
    screen.unmount();
    const writes = screen.writes;
    screen.advance(70_000);
    if (outcome === 'success') pending.resolve();
    else pending.reject();
    await setImmediate();
    assert.equal(screen.writes, writes, 'unmounted completion must not update any state, including the clock');
  });
}
