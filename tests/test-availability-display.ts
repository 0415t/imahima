import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { it } from 'node:test';
import { loadSource } from './helpers/load-source';

it('updates expired rows even after repeated fetch failures with unchanged error state', async () => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  let fail = false;
  let cursor = 0;
  let dirty = false;
  let refresh!: () => void;
  let cleanup: (() => void) | undefined;
  const states: unknown[] = [];
  const user = { id: 'self', username: 'test', is_free: true, free_until: new Date(now + 60_000).toISOString() };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value: unknown) => {
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
      from: () => ({ select: () => ({
        limit: async () => ({ data: [user] }),
        eq: () => ({ maybeSingle: async () => ({ data: user }) }),
      }) }),
    } },
  }, {
    React: react,
    Date: class extends Date { static now() { return now; } },
    setInterval(callback: () => void) { refresh = callback; return 1; }, clearInterval() {},
  });
  const render = () => { cursor = 0; dirty = false; return JSON.stringify(screen.default()); };
  try {
    render();
    await setImmediate();
    assert.match(render(), /暇状態: .*ON/);
    fail = true;
    now += 30_000;
    refresh();
    await setImmediate();
    render(); // Error and loading values now match all subsequent failed fetches.
    now += 30_001;
    refresh();
    await setImmediate();
    assert.equal(dirty, true, 'a failed refresh must still schedule a render');
    const expired = render();
    assert.match(expired, /暇状態: .*OFF/);
    assert.match(expired, /暇状態の取得に失敗しました/);
  } finally { cleanup?.(); }
});
