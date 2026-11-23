import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { createExtendClient, notificationReceivedAt } from '../lib/free-end-action';
import { createLogoutFlow, type LogoutSession } from '../lib/logout-flow';
import { loadSource } from './helpers/load-source';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    const stored = new Map<string, string>();
    const rows = new Map([['here', 'A'], ['other', 'A'], ['b-device', 'B']]);
    const sessions = new Set(['a-here', 'a-other', 'b-here']);
    const events: string[] = [];
    let current: LogoutSession | null = { user: { id: 'A' }, access_token: 'a-here' };
    const deps = {
        prefix: 'test',
        storage: {
            async getItem(key: string) { return stored.get(key) ?? null; },
            async setItem(key: string, value: string) { stored.set(key, value); },
            async removeItem(key: string) { stored.delete(key); },
        },
        session: async () => current,
        resolveToken: async (): Promise<string | null> => 'here',
        hasRegistrations: async (session: LogoutSession) => [...rows.values()].includes(session.user.id),
        register: async (session: LogoutSession, token: string): Promise<{ rejected: Error | null }> => {
            events.push('register:' + session.user.id);
            rows.set(token, session.user.id);
            return { rejected: null };
        },
        remove: async (session: LogoutSession, token: string) => {
            events.push('delete:' + token);
            if (rows.get(token) === session.user.id) rows.delete(token);
        },
        revoke: async () => {},
        signOut: async () => {
            events.push('auth');
            if (current) sessions.delete(current.access_token);
            current = null;
        },
    };
    return { deps, rows, sessions, events, flow: createLogoutFlow(deps),
        setSession: (session: LogoutSession) => { current = session; } };
}

test('logs out locally after removing only the current account and device registration', async () => {
    const { flow, deps, rows, sessions, events } = fixture();
    assert.deepEqual(await flow.signOut(), { error: null });
    assert.deepEqual(events, ['delete:here', 'auth']);
    assert.deepEqual([...rows], [['other', 'A'], ['b-device', 'B']]);
    assert.deepEqual([...sessions], ['a-other', 'b-here']);
    assert.equal(await deps.session(), null);
    assert.equal(await createLogoutFlow(deps).canUseSession(), true);
});

test('logs out when push is unsupported, the resolved token is absent, or the account has no token rows', async () => {
    for (const mode of ['web', 'no-row', 'no-token']) {
        const { deps, flow, rows, events } = fixture();
        rows.delete('here');
        if (mode === 'web') deps.resolveToken = async () => null;
        if (mode === 'no-token') {
            rows.delete('other');
            deps.resolveToken = async () => { throw new Error('no token'); };
        }
        assert.equal((await flow.signOut()).error, null, mode);
        assert.deepEqual(events, mode === 'no-row' ? ['delete:here', 'auth'] : ['auth']);
    }
});

test('fails closed on ambiguous token, storage read failure and delete failure', async () => {
    for (const mode of ['resolve', 'storage', 'delete']) {
        const { deps, flow, events } = fixture();
        if (mode === 'resolve') deps.resolveToken = async () => { throw new Error('offline'); };
        if (mode === 'storage') deps.storage.getItem = async () => { throw new Error('unreadable'); };
        if (mode === 'delete') deps.remove = async () => { throw new Error('offline'); };
        assert.ok((await flow.signOut()).error, mode);
        assert.equal(await flow.canUseSession(), false);
        assert.equal(await createLogoutFlow(deps).canUseSession(), false);
        assert.deepEqual(events, []);
        await assert.rejects(flow.authenticate(async () => assert.fail('sign-in must wait')));
    }
});

test('Auth failure preserves the deletion target for a retry and suppresses re-registration', async () => {
    const { flow, deps, events } = fixture();
    const revoke = deps.revoke;
    deps.revoke = async () => { throw new Error('Auth temporarily offline'); };
    assert.match((await flow.signOut()).error!.message, /Auth/);
    assert.ok(await deps.session());
    deps.revoke = revoke;
    deps.resolveToken = async () => assert.fail('retry must reuse the saved target');
    await flow.save('A', 'here');
    assert.equal((await flow.signOut()).error, null);
    assert.deepEqual(events, ['delete:here', 'delete:here', 'auth']);
});

test('real Auth SDK keeps the session available for retry until remote local revocation succeeds', async () => {
    const { deps } = fixture();
    const revoked = new Set<string>();
    const scopes: string[] = [];
    let fail = true;
    const fetchAuth: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, '/auth/v1/logout');
        assert.equal(init?.method, 'POST');
        assert.equal(url.searchParams.get('scope'), 'local');
        scopes.push(url.searchParams.get('scope')!);
        const bearer = new Headers(init?.headers).get('authorization');
        assert.equal(bearer, 'Bearer a-here');
        if (fail) return Response.json({ message: 'offline' }, { status: 503 });
        revoked.add(bearer);
        return new Response(null, { status: 204 });
    };
    function client(storageKey: string) {
        return createClient('https://auth.example.test', 'test-key', {
            global: { fetch: fetchAuth },
            auth: { storageKey, storage: deps.storage, autoRefreshToken: false, detectSessionInUrl: false },
        });
    }
    for (const [key, token] of [['here-auth', 'a-here'], ['other-auth', 'a-other']]) {
        await deps.storage.setItem(key, JSON.stringify({
            access_token: token, refresh_token: token + '-refresh',
            expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'A' },
        }));
    }
    const here = client('here-auth');
    const { logoutFlow } = loadSource<{ logoutFlow: ReturnType<typeof createLogoutFlow> }>('lib/logout.ts', {
        './auth-storage': { __esModule: true, default: deps.storage },
        './logout-flow': { createLogoutFlow },
        './push-notifications': {
            getCurrentDeviceToken: deps.resolveToken, registerDeviceToken: deps.register, removeDeviceToken: deps.remove,
        },
        './supabase': { supabase: here },
    }, { process: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://auth.example.test' } } });

    assert.ok((await logoutFlow.signOut()).error);
    assert.deepEqual(scopes, ['local']);
    assert.equal((await here.auth.getSession()).data.session?.access_token, 'a-here');
    assert.equal(await logoutFlow.canUseSession(), false);
    fail = false;
    assert.equal((await logoutFlow.signOut()).error, null);
    assert.deepEqual(scopes, ['local', 'local', 'local']);
    assert.deepEqual([...revoked], ['Bearer a-here']);
    assert.equal((await client('here-auth').auth.getSession()).data.session, null);
    assert.equal((await client('other-auth').auth.getSession()).data.session?.access_token, 'a-other');
});

test('the PostgREST adapter sends a DELETE with both exact filters and the original session bearer', async () => {
    const token = 'ExponentPushToken[test]';
    let requests = 0;
    const { removeDeviceToken } = loadSource<{ removeDeviceToken(session: LogoutSession, token: string): Promise<void> }>(
        'lib/push-notifications.ts', {
            'expo-constants': {}, 'expo-device': {}, 'expo-notifications': { setNotificationHandler() {} },
            'react-native': {}, './free-end-action': {},
            './supabase': {
                createSessionDataClient: (bearer: string) => createClient('https://data.example.test', 'test-key', {
                    accessToken: async () => bearer,
                    global: { fetch: async (input, init) => {
                        requests++;
                        try {
                            assert.equal(init?.method, 'DELETE');
                            assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer a-here');
                            const url = new URL(String(input));
                            assert.equal(url.pathname, '/rest/v1/user_device_tokens');
                            assert.equal(url.searchParams.get('user_id'), 'eq.A');
                            assert.equal(url.searchParams.get('expo_push_token'), 'eq.' + token);
                            return new Response(null, { status: 204 });
                        } catch (error) { return Response.json({ message: String(error) }, { status: 400 }); }
                    } },
                }),
            },
        },
    );
    await removeDeviceToken({ user: { id: 'A' }, access_token: 'a-here' }, token);
    assert.equal(requests, 1);
});

test('duplicate logout shares the promise and drains an in-flight registration', async () => {
    const { flow, deps, rows, events } = fixture();
    const entered = deferred<void>();
    const complete = deferred<void>();
    const register = deps.register;
    deps.register = async (session, token) => {
        entered.resolve();
        await complete.promise;
        return register(session, token);
    };
    const saving = flow.save('A', 'here');
    await entered.promise;
    const a = flow.signOut();
    assert.equal(a, flow.signOut());
    assert.equal(flow.isBlocked(), true);
    const queued = flow.save('A', 'here');
    assert.deepEqual(events, []);
    complete.resolve();
    await saving;
    assert.equal((await a).error, null);
    await queued;
    assert.deepEqual(events, ['register:A', 'delete:here', 'auth']);
    assert.equal(rows.has('here'), false);
});

test('a lost registration response blocks logout across restart', async () => {
    const { flow, deps, events } = fixture();
    deps.register = async () => { throw new Error('network'); };
    await assert.rejects(flow.save('A', 'here'), /network/);
    assert.match((await createLogoutFlow(deps).signOut()).error!.message, /outcome is unknown/);
    assert.deepEqual(events, []);
});

test('a missing session cannot turn a failed logout into success after restart', async () => {
    const { flow, deps, events } = fixture();
    deps.remove = async () => { throw new Error('offline'); };
    assert.ok((await flow.signOut()).error);
    deps.session = async () => null;
    const restarted = createLogoutFlow(deps);
    assert.match((await restarted.signOut()).error!.message, /session is unavailable/);
    assert.equal(await restarted.canUseSession(), false);
    assert.deepEqual(events, []);
});

test('switching to B re-registers the device, and an A delete can never remove B’s row', async () => {
    const { flow, deps, rows, setSession, events } = fixture();
    assert.equal((await flow.signOut()).error, null);
    await flow.authenticate(async () => setSession({ user: { id: 'B' }, access_token: 'b-here' }));
    await flow.save('A', 'here');
    await flow.save('B', 'here');
    assert.equal(rows.get('here'), 'B');
    await deps.remove({ user: { id: 'A' }, access_token: 'a-here' }, 'here');
    assert.equal(rows.get('here'), 'B');
    assert.deepEqual(events, ['delete:here', 'auth', 'register:B', 'delete:here']);
});

test('logout rejects old notification actions and discards a late authenticated response', async () => {
    const { flow, deps, setSession } = fixture();
    const result = deferred<Response>();
    const sent = deferred<void>();
    let requests = 0;
    let updates = 0;
    const date = Math.floor((Date.now() - 5000) / 1000);
    const receivedAt = notificationReceivedAt({ notification: { date } });
    assert.equal(receivedAt, date * 1000);
    assert.equal(notificationReceivedAt({ notification: { date: date * 1000 } }), receivedAt);
    const revision = flow.revision();
    const extend = createExtendClient({
        apiUrl: 'http://localhost',
        getAccessToken: async () => (await deps.session())?.access_token ?? null,
        canUseToken: async () => await flow.canUseNotification(receivedAt) && flow.revision() === revision,
        fetch: async () => {
            requests++;
            sent.resolve();
            return result.promise;
        },
        onChanged: () => { updates++; },
    });
    const inFlight = extend('/profiles/me/is-free/extend-from-notification');
    await sent.promise;
    const logout = flow.signOut();
    assert.deepEqual(await extend('/profiles/me/is-free/extend-from-notification'),
        { ok: false, reason: 'not-authenticated' });
    assert.equal((await logout).error, null);
    setSession({ user: { id: 'A' }, access_token: 'a-new' });
    assert.equal(await createLogoutFlow(deps).canUseNotification(receivedAt), false);
    result.resolve(Response.json({ is_free: true, free_until: new Date().toISOString() }));
    assert.deepEqual(await inFlight, { ok: false, reason: 'not-authenticated' });
    assert.equal(requests, 1);
    assert.equal(updates, 0);
});
