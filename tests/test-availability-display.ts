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
  let revision = 0;
  let refresh!: () => void;
  let changed!: () => void;
  let requests = 0;
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
    '@/lib/availability-events': { subscribeAvailabilityChanged: (callback: () => void) => { changed = callback; return () => {}; } },
    '@/lib/logout': { logoutFlow: { revision: () => revision, canUseSession: async () => revision === 0 } },
    '@/lib/supabase': { hasSupabaseConfig: true, supabase: {
      auth: { async getSession() {
        requests += 1;
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
    changed: () => changed(),
    get requests() { return requests; },
    advance: (milliseconds: number) => { now += milliseconds; },
    failAuth: () => { fail = true; },
    unmount: () => { cleanup?.(); },
    beginLogout: () => { revision++; },
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

it('discards a profile response arriving after logout begins, even before unmount', async () => {
  const screen = createScreen();
  const pending = screen.deferProfiles();
  screen.render();
  try {
    await setImmediate();
    const writes = screen.writes;
    screen.beginLogout();
    pending.resolve({ username: 'old account' });
    await setImmediate();
    assert.equal(screen.writes, writes);
  } finally { screen.unmount(); }
});

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

it('advances displayed expiry while a refresh remains pending without starting more requests', async () => {
  const screen = createScreen();
  try {
    screen.render();
    await setImmediate();
    assert.match(screen.render(), /暇状態: .*ON/);
    const pending = screen.deferProfiles();
    screen.advance(30_000);
    screen.refresh();
    await setImmediate();
    const requests = screen.requests;
    screen.advance(30_001);
    screen.refresh();
    assert.match(screen.render(), /暇状態: .*OFF/);
    screen.advance(30_000);
    screen.refresh();
    await setImmediate();
    assert.equal(screen.requests, requests);
    assert.match(screen.render(), /暇状態: .*OFF/);
    pending.resolve();
    await setImmediate();
    assert.match(screen.render(), /暇状態: .*OFF/);
  } finally { screen.unmount(); }
});

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
      screen.changed();
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

it('does not supersede a slow request on periodic ticks, but accepts explicit refreshes', async () => {
  const screen = createScreen();
  try {
    const pending = screen.deferProfiles();
    screen.render();
    await setImmediate();
    screen.advance(30_000);
    screen.refresh();
    screen.advance(30_000);
    screen.refresh();
    await setImmediate();
    assert.equal(screen.requests, 1);
    pending.resolve({ username: 'slow-profile' });
    await setImmediate();
    assert.match(screen.render(), /slow-profile/);
    screen.refresh();
    await setImmediate();
    assert.equal(screen.requests, 2, 'periodic refresh resumes after completion');
  } finally { screen.unmount(); }
});

it('an obsolete completion does not allow polling to supersede the latest pending request', async () => {
  const screen = createScreen();
  try {
    const older = screen.deferProfiles();
    screen.render();
    await setImmediate();
    const latest = screen.deferProfiles();
    screen.changed();
    await setImmediate();
    older.resolve({ username: 'obsolete' });
    await setImmediate();
    screen.advance(30_000);
    screen.refresh();
    await setImmediate();
    assert.equal(screen.requests, 2);
    latest.resolve({ username: 'latest' });
    await setImmediate();
    assert.match(screen.render(), /latest/);
    assert.doesNotMatch(screen.render(), /obsolete/);
  } finally { screen.unmount(); }
});

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


function startupLayout(failure: 'throw' | 'error', initialEvent = false) {
  let authListener: ((event: string, session: null) => void) | undefined;
  let cursor = 0, reads = 0, failed = true, prepared = 0;
  const states: unknown[] = [], effects: { deps: unknown[]; cleanup?: () => void }[] = [];
  const pending: (() => void)[] = [];
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (next: unknown) => { states[i] = typeof next === 'function' ? next(states[i]) : next; }];
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const i = cursor++;
      const previous = effects[i];
      if (!previous || previous.deps.length !== deps.length || deps.some((v, k) => !Object.is(v, previous.deps[k]))) {
        previous?.cleanup?.();
        effects[i] = { deps };
        pending.push(() => { effects[i].cleanup = effect(); });
      }
    },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot(); },
  };
  const Stack = Object.assign('stack', { Protected: 'protected', Screen: 'screen' });
  const module = loadSource<{ default(): unknown }>('app/_layout.tsx', {
    react, 'react-native': { ActivityIndicator: 'spinner', Button: 'button', Platform: { OS: 'android' },
      StyleSheet: { create: (s: unknown) => s } },
    'expo-notifications': { addNotificationResponseReceivedListener: () => ({ remove() {} }),
      getLastNotificationResponseAsync: async () => null },
    'expo-router': { Stack }, 'expo-status-bar': { StatusBar: 'status' }, 'react-native-reanimated': {},
    '@react-navigation/native': { DarkTheme: {}, DefaultTheme: {}, ThemeProvider: 'theme' },
    '@/components/themed-text': { ThemedText: 'text' }, '@/components/themed-view': { ThemedView: 'view' },
    '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
    '@/lib/notification-task': { handleFreeEndAction: async () => null },
    '@/lib/session-identity': { jwtSessionId: () => 'session' },
    '@/lib/push-notifications': { registerNotificationCategories: async () => {}, registerForPushNotificationsAsync: async () => null },
    '@/lib/logout': { logoutFlow: { subscribe() {}, isBlocked: () => false, getError: () => null,
      revision: () => 0, isAuthenticating: () => false, sessionAvailability: async () => 'ready',
      prepareSession: async () => { prepared++; }, signOut: () => assert.fail('Read errors must not sign out') } },
    '@/lib/supabase': { hasSupabaseConfig: true, supabase: { auth: {
      onAuthStateChange: (callback: typeof authListener) => {
        authListener = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async getSession() {
        reads++;
        if (failed && initialEvent) authListener?.('INITIAL_SESSION', null);
        if (failed && failure === 'throw') throw Error('Auth storage unavailable');
        return { data: { session: failed ? null : { user: { id: 'self' }, access_token: 'test' } },
          error: failed ? Error('Auth storage unavailable') : null };
      },
    } } },
  }, { React: react });
  let tree: unknown;
  async function render() {
    for (let i = 0; i < 6; i++) {
      cursor = 0; tree = module.default();
      pending.splice(0).forEach(effect => effect());
      await setImmediate();
    }
    return JSON.stringify(tree);
  }
  function buttons(node: unknown): { title: string; onPress(): void }[] {
    if (!node || typeof node !== 'object') return [];
    const entry = node as { type?: string; props?: { title: string; onPress(): void }; children?: unknown[] };
    return [...(entry.type === 'button' && entry.props ? [entry.props] : []), ...(entry.children ?? []).flatMap(buttons)];
  }
  return { render, retry() { failed = false; buttons(tree).find(b => b.title === '\u518d\u78ba\u8a8d')!.onPress(); },
    get reads() { return reads; }, get prepared() { return prepared; },
    close() { effects.forEach(effect => effect?.cleanup?.()); } };
}

for (const failure of ['throw', 'error'] as const) {
  it(`startup Auth ${failure} reaches a retryable screen without INITIAL_SESSION`, async () => {
    const screen = startupLayout(failure);
    try {
      const failed = await screen.render();
      assert.match(failed, /\u30ed\u30b0\u30a4\u30f3/);
      assert.doesNotMatch(failed, /spinner|protected/);
      assert.equal(screen.reads, 1);
      assert.equal(screen.prepared, 0);
      screen.retry();
      assert.match(await screen.render(), /protected/);
      assert.equal(screen.reads, 2);
      assert.equal(screen.prepared, 1);
    } finally { screen.close(); }
  });
}


it('an INITIAL_SESSION null fallback cannot hide an explicit Auth read error', async () => {
  const screen = startupLayout('error', true);
  try {
    assert.match(await screen.render(), /\u30ed\u30b0\u30a4\u30f3/);
    assert.equal(screen.prepared, 0);
    screen.retry();
    assert.match(await screen.render(), /protected/);
    assert.equal(screen.prepared, 1);
  } finally { screen.close(); }
});
