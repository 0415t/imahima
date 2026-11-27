import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createClient, isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import { createExtendClient, notificationReceivedAt } from '../lib/free-end-action';
import { createLogoutFlow, type LogoutSession } from '../lib/logout-flow';
import { createManagedLogout, type ManagedDeviceApi } from '../lib/managed-logout';
import { jwtSessionId } from '../lib/session-identity';
import { loadSource } from './helpers/load-source';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function sessionToken(sessionId: string) {
    return 'header.' + Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url') + '.sig';
}

const hereToken = sessionToken('a-here');

function fixture() {
    const stored = new Map<string, string>();
    const rows = new Map([['here', 'A'], ['other', 'A'], ['b-device', 'B']]);
    const sessions = new Set([hereToken, 'a-other', 'b-here']);
    const events: string[] = [];
    let current: LogoutSession | null = { user: { id: 'A' }, access_token: hereToken };
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

test('a queued legacy registration runs after a definite rejection', async () => {
    const { deps, rows } = fixture();
    const register = deps.register;
    deps.register = async (session, token) => token === 'rejected'
        ? { rejected: new Error('Definite rejection') } : register(session, token);
    const flow = createLogoutFlow(deps);
    const [first, second] = await Promise.allSettled([flow.save('A', 'rejected'), flow.save('A', 'fresh')]);
    assert.equal(first.status, 'rejected');
    assert.equal(second.status, 'fulfilled');
    assert.equal(rows.get('fresh'), 'A');
});

function managedFixture() {
    const userId = '01000000-0000-0000-0000-000000000001';
    const sessionId = '02000000-0000-0000-0000-000000000002';
    const installationId = '03000000-0000-0000-0000-000000000003';
    const recoveryId = '04000000-0000-0000-0000-000000000004';
    const stored = new Map<string, string>();
    const events: string[] = [];
    const a = { user: { id: userId }, access_token: sessionToken(sessionId) };
    let current: LogoutSession | null = a;
    let authPresent = true, fenced = false, confirmed = false, acked = false;
    let fail = '', keyAvailable = true, initialized = false;
    let operations = 0;
    const failOnce = (name: string) => {
        if (fail === name) { fail = ''; throw new Error('interrupted ' + name); }
    };
    const api: ManagedDeviceApi = {
        async identity(create) {
            if (create && keyAvailable) initialized = true;
            return keyAvailable && initialized ? installationId : null;
        },
        operationId: () => `05000000-0000-0000-0000-${String(++operations).padStart(12, '0')}`,
        async ensureInstallation() { events.push('ensure-key'); failOnce('ensure-key'); },
        open: async () => { events.push('open'); failOnce('open'); return '1'; },
        async lookupGeneration() { return null; },
        async register() {
            events.push('register');
            if (fail === 'reject-restore') { fail = 'write:test:device-v2'; return 'rejected'; }
            if (fail === 'reject-register') { fail = ''; return 'rejected'; }
            failOnce('register');
        },
        async lookupRegistration() {
            failOnce('lookup');
            if (fail === 'found-registration') { fail = ''; return 'registered'; }
            if (fail === 'found-rejection') { fail = ''; return 'rejected'; }
            return 'unknown';
        },
        async begin(session, entry) {
            assert.equal(session, a);
            assert.equal(entry.installationId, installationId);
            assert.ok(entry.generation === undefined || entry.generation === '1');
            assert.equal(JSON.parse(stored.get('test:logout-v2-intent')!).operationId, entry.operationId);
            events.push('begin:' + entry.operationId);
            fenced = true;
            failOnce('begin');
            return recoveryId;
        },
        async recovery(_installation, action, id, binding) {
            events.push(action);
            if (!fenced) throw new Error('No proven recovery');
            if (action === 'discover-binding') {
                assert.equal(binding?.userId, userId);
                assert.equal(binding?.sessionId, sessionId);
            }
            if (action === 'confirm' || action === 'ack') assert.equal(id, recoveryId);
            if (action === 'confirm' && !authPresent) confirmed = true;
            if (action === 'ack') {
                assert.equal(confirmed, true);
                assert.equal(current, null);
                assert.equal(stored.has('test:notification-cutoff'), true);
                assert.equal(JSON.parse(stored.get('test:logout-v2')!).stage, 'ack');
                acked = true;
            }
            failOnce(action);
            return { recoveryId, status: acked ? 'cleared' : confirmed ? 'confirmed' : 'pending' };
        },
    };
    const storage = {
        async getItem(key: string) { failOnce('read:' + key); return stored.get(key) ?? null; },
        async setItem(key: string, value: string) { failOnce('write:' + key); stored.set(key, value); },
        async removeItem(key: string) { failOnce('remove:' + key); stored.delete(key); },
    };
    function restart() {
        const session = async () => current;
        return createLogoutFlow({
            ...fixture().deps, storage, session, hasRegistrations: async () => false,
            register: async () => assert.fail('Managed registration cannot fall back'),
            remove: async () => assert.fail('Managed logout cannot fall back'),
            managed: createManagedLogout({
                storage, session, api, enableNew: true, prefix: 'test',
                async revoke(session) {
                    assert.equal(session, a);
                    events.push('revoke');
                    failOnce('before-revoke');
                    authPresent = false;
                    failOnce('revoke');
                },
                async clean() { assert.equal(confirmed, true); events.push('clear'); current = null; failOnce('clear'); },
            }),
        });
    }
    return { stored, events, a, restart, failAt: (name: string) => { fail = name; },
        replaceSession: (session: LogoutSession | null) => { current = session; },
        loseAuth: () => { current = null; authPresent = false; },
        loseKey: () => { keyAvailable = false; }, api };
}

for (const fault of ['begin', 'confirm', 'clear', 'ack', 'write:test:logout-v2',
    'write:test:notification-cutoff', 'remove:test:logout-v2-intent', 'remove:test:logout-v2']) {
    test(`managed logout resumes after process loss at ${fault}`, async () => {
        const { stored, events, a, restart, failAt } = managedFixture();
        const flow = restart();
        await flow.save(a.user.id, 'test-push');
        failAt(fault);
        const first = flow.signOut();
        assert.equal(first, flow.signOut());
        assert.equal(await flow.canUseSession(), false);
        assert.ok((await first).error);
        const resumed = restart();
        assert.equal(await resumed.sessionAvailability(), 'logout-pending');
        assert.equal(await resumed.canUseNotification(Date.now() + 1000), false);
        await assert.rejects(resumed.authenticate(() => assert.fail('Sign-in is blocked')));
        assert.deepEqual(await resumed.signOut(), { error: null });
        assert.equal(stored.has('test:logout-v2'), false);
        assert.equal(stored.has('test:logout-v2-intent'), false);
        assert.equal(stored.has('test:device-v2'), false);
        assert.equal(events.indexOf('clear') > events.indexOf('confirm'), true);
        assert.equal(events.indexOf('ack') > events.indexOf('clear'), true);
        assert.equal(new Set(events.filter(event => event.startsWith('begin:'))).size, 1);
    });
}

test('managed logout confirms after a lost Auth reply and fences an unknown registration', async () => {
    const { a, events, restart, failAt } = managedFixture();
    const flow = restart();
    failAt('register');
    await assert.rejects(flow.save(a.user.id, 'test-push'));
    failAt('revoke');
    assert.deepEqual(await flow.signOut(), { error: null });
    assert.equal(events.filter(event => event === 'register').length, 1);
    assert.ok(events.includes('confirm'));
});

test('a definitive rejection releases only a fresh managed registration', async () => {
    const { a, stored, events, restart, failAt } = managedFixture();
    failAt('reject-register');
    await assert.rejects(restart().save(a.user.id, 'first'));
    assert.equal(JSON.parse(stored.get('test:device-v2')!).registration, undefined);
    failAt('register');
    await assert.rejects(restart().save(a.user.id, 'second'));
    const pending = stored.get('test:device-v2');
    failAt('reject-register');
    await assert.rejects(restart().save(a.user.id, 'second'));
    assert.equal(stored.get('test:device-v2'), pending);
    failAt('lookup');
    await assert.rejects(restart().save(a.user.id, 'third'), /interrupted lookup/);
    assert.equal(stored.get('test:device-v2'), pending);
    const beforeLookup = events.filter(event => event === 'register').length;
    failAt('found-registration');
    await restart().save(a.user.id, 'second');
    assert.equal(events.filter(event => event === 'register').length, beforeLookup);
    await restart().save(a.user.id, 'third');
    assert.equal(JSON.parse(stored.get('test:device-v2')!).registration.done, true);
});

test('a known managed rejection repairs a failed checkpoint in the same process', async () => {
    const { a, stored, restart, failAt } = managedFixture();
    const flow = restart();
    failAt('reject-restore');
    await assert.rejects(flow.save(a.user.id, 'rejected'), /interrupted write/);
    await flow.save(a.user.id, 'fresh');
    assert.equal(JSON.parse(stored.get('test:device-v2')!).registration.token, 'fresh');
});

test('a server-recorded registration rejection repairs a failed checkpoint after restart', async () => {
    const { a, stored, events, restart, failAt } = managedFixture();
    failAt('reject-restore');
    await assert.rejects(restart().save(a.user.id, 'rejected'), /interrupted write/);
    const attempts = events.filter(event => event === 'register').length;
    failAt('found-rejection');
    await restart().save(a.user.id, 'fresh');
    assert.equal(events.filter(event => event === 'register').length, attempts + 1);
    assert.equal(JSON.parse(stored.get('test:device-v2')!).registration.token, 'fresh');
});

test('notifications received during account authentication remain ineligible', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 100 });
    const { flow, setSession } = fixture();
    assert.deepEqual(await flow.signOut(), { error: null });
    await flow.authenticate(async () => {
        t.mock.timers.setTime(200);
        assert.equal(await flow.canUseNotification(200), false);
        setSession({ user: { id: 'B' }, access_token: 'b-here' });
        assert.equal(await flow.canUseNotification(200), false);
        t.mock.timers.setTime(300);
    });
    assert.equal(await flow.canUseNotification(200), false);
    assert.equal(await flow.canUseNotification(301), true);
});

test('logout never creates a generation to resolve a lost generation-opening reply', async () => {
    const { a, events, restart, failAt } = managedFixture();
    const flow = restart();
    failAt('open');
    await assert.rejects(flow.save(a.user.id, 'test-push'));
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.equal(events.filter(event => event === 'open').length, 1);
    assert.ok(events.includes('revoke'));
});

test('damaged managed journal finds a case using the old binding when all copies of the case ID are lost', async () => {
    const { stored, events, a, restart, failAt, loseAuth } = managedFixture();
    const start = restart();
    await start.save(a.user.id, 'test-push');
    failAt('begin');
    assert.ok((await start.signOut()).error);
    stored.set('test:logout-v2', '{broken');
    stored.delete('test:logout-v2-intent');
    loseAuth();
    const resumed = restart();
    assert.equal(await resumed.sessionAvailability(), 'logout-pending');
    assert.deepEqual(await resumed.signOut(), { error: null });
    assert.ok(events.includes('discover-binding'));
    assert.ok(events.includes('ack'));
});

test('damaged managed journal resumes without the old JWT when the discovered case matches the backup', async () => {
    const { stored, events, a, restart, failAt, replaceSession } = managedFixture();
    const start = restart();
    await start.save(a.user.id, 'test-push');
    failAt('confirm');
    assert.ok((await start.signOut()).error);
    stored.set('test:logout-v2', '{broken');
    replaceSession(null);
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.ok(events.includes('discover-binding'));
    assert.ok(events.includes('ack'));
});

test('a known recovery ID does not unlock while the lost JWT still has a live Auth row', async () => {
    const { a, restart, events, failAt, replaceSession } = managedFixture();
    const flow = restart();
    await flow.save(a.user.id, 'test-push');
    failAt('before-revoke');
    assert.match((await flow.signOut()).error!.message, /Old session remains/);
    replaceSession(null);
    assert.match((await restart().signOut()).error!.message, /Old session remains/);
    assert.equal(events.filter(event => event === 'revoke').length, 1);
    assert.ok(!events.includes('ack'));
});

test('managed session read errors, account substitution and key loss block cleanup', async () => {
    const { stored, events, a, restart, failAt, replaceSession, loseKey } = managedFixture();
    await restart().save(a.user.id, 'test-push');
    failAt('read:test:logout-v2');
    assert.equal(await restart().sessionAvailability(), 'read-failed');
    assert.equal(await restart().sessionAvailability(), 'ready');
    replaceSession({ ...a, access_token: sessionToken('06000000-0000-0000-0000-000000000006') });
    assert.equal(await restart().sessionAvailability(), 'logout-pending');
    assert.match((await restart().signOut()).error!.message, /session changed/);
    replaceSession(a);
    loseKey();
    assert.equal(await restart().sessionAvailability(), 'logout-pending');
    assert.match((await restart().signOut()).error!.message, /key is unavailable/);
    assert.equal(stored.has('test:device-v2'), true);
    assert.ok(!events.includes('clear'));
});

test('lost managed records never unlock without a verified local scope', async () => {
    const { stored, events, a, restart, failAt } = managedFixture();
    const flow = restart();
    await flow.save(a.user.id, 'test-push');
    failAt('begin');
    assert.ok((await flow.signOut()).error);
    stored.clear();
    const resumed = restart();
    assert.equal(await resumed.sessionAvailability(), 'logout-pending');
    assert.match((await resumed.signOut()).error!.message, /no verified local scope/);
    assert.ok(!events.includes('discover-binding'));
    assert.ok(!events.includes('clear'));
    assert.ok(!events.includes('ack'));
});

test('logout retries interrupted public key registration without opening a generation', async () => {
    for (const losingJwt of [false, true]) {
        const { a, restart, events, failAt, replaceSession } = managedFixture();
        failAt('ensure-key');
        await assert.rejects(restart().save(a.user.id, 'test-push'));
        if (losingJwt) replaceSession(null);
        const { error } = await restart().signOut();
        assert.equal(Boolean(error), losingJwt);
        assert.equal(events.filter(event => event === 'ensure-key').length, losingJwt ? 1 : 2);
        assert.ok(!events.includes('open'));
        assert.equal(events.includes('ack'), !losingJwt);
    }
});

test('production adapter uses JWT only for begin and exact HTTP fields for recovery', async () => {
    const id = '03000000-0000-0000-0000-000000000003';
    const recoveryId = '04000000-0000-0000-0000-000000000004';
    const session = { user: { id }, access_token: sessionToken(id) };
    const requests: { url: string; body: Record<string, string>; headers: Record<string, string> }[] = [];
    const proofs: Record<string, string>[] = [];
    let initializationCalls = 0;
    let lookupResult: unknown = null;
    const { createDeviceRecoveryApi } = loadSource<{
        createDeviceRecoveryApi(api: string, auth: string): ManagedDeviceApi;
    }>('lib/device-recovery-api.ts', {
        'expo-modules-core': { uuid: { v4: randomUUID } },
        'react-native': { Platform: { OS: 'android' } },
        './session-identity': { jwtSessionId },
        '../modules/device-key': {
            supportsLogoutRecoverySigning: () => true,
            getIdentity: async () => ({ status: 'initializing' }),
            createInstallation: async () => {
                initializationCalls++;
                return { status: 'ready', installationId: id };
            },
            async signDeviceProof(input: Record<string, string>) { proofs.push(input); return { status: 'ready', signature: 'test' }; },
            async signLogoutRecoveryProof(input: Record<string, string>) { proofs.push(input); return { status: 'ready', signature: 'test' }; },
        },
    }, {
        URL, AbortController, setTimeout, clearTimeout,
        fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
            requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
            return { status: 200, json: async () => url.endsWith('/challenge') ? { nonce: 'A'.repeat(43) } :
                { result: url.endsWith('/lookup') ? lookupResult : { status: 'confirmed', recoveryId } } };
        },
    });
    const api = createDeviceRecoveryApi('https://express.example.test', 'https://auth.example.test');
    assert.equal(await api.identity(false), null);
    assert.equal(initializationCalls, 0);
    assert.equal(await api.identity(true), id);
    assert.equal(initializationCalls, 1);
    assert.equal(await api.begin(session, { installationId: id, sessionId: id, userId: id, operationId: id, generation: '1' }), recoveryId);
    assert.equal((await api.recovery(id, 'discover')).recoveryId, recoveryId);
    assert.equal((await api.recovery(id, 'confirm', recoveryId)).status, 'confirmed');
    assert.deepEqual(requests.map(r => new URL(r.url).pathname), [
        '/device-recovery/challenge', '/device-recovery/begin-logout', '/device-recovery/recovery/challenge',
        '/device-recovery/recovery/discover', '/device-recovery/recovery/challenge', '/device-recovery/recovery/confirm',
    ]);
    assert.ok(requests.slice(0, 2).every(r => r.headers.authorization === 'Bearer ' + session.access_token));
    assert.ok(requests.slice(2).every(r => !r.headers.authorization));
    assert.ok(requests.every(r => !('issuer' in r.body || 'userId' in r.body || 'sessionId' in r.body || 'action' in r.body)));
    assert.ok(proofs.slice(2).every(p => !('userId' in p || 'sessionId' in p)));
    assert.ok(!('recoveryId' in requests[3].body));
    assert.equal(requests[5].body.recoveryId, recoveryId);
    assert.equal(await api.lookupRegistration(session, id, '1', id), 'unknown');
    lookupResult = { registered: false, generation: '1', reason: 'device_token_unavailable' };
    assert.equal(await api.lookupRegistration(session, id, '1', id), 'rejected');
    await assert.rejects(api.lookupRegistration(session, id, '2', id), /Invalid push registration lookup/);
    lookupResult = { registered: false, generation: '1', reason: 'unrecognized' };
    await assert.rejects(api.lookupRegistration(session, id, '1', id), /Invalid push registration lookup/);
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

for (const alreadyRevoked of [false, true]) {
test(`real Auth SDK retries until remote revocation is ${alreadyRevoked ? 'confirmed by session_not_found' : 'successful'}`, async () => {
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
        assert.equal(bearer, 'Bearer ' + hereToken);
        if (fail) return Response.json({ code: 'unexpected_failure', message: 'blocked' }, { status: 403 });
        revoked.add(bearer);
        if (alreadyRevoked) return Response.json({ code: 'session_not_found', message: 'session missing' }, {
            status: 403, headers: { 'x-supabase-api-version': '2024-01-01' },
        });
        return new Response(null, { status: 204 });
    };
    function client(storageKey: string) {
        return createClient('https://auth.example.test', 'test-key', {
            global: { fetch: fetchAuth },
            auth: { storageKey, storage: deps.storage, autoRefreshToken: false, detectSessionInUrl: false },
        });
    }
    for (const [key, token] of [['here-auth', hereToken], ['other-auth', 'a-other']]) {
        await deps.storage.setItem(key, JSON.stringify({
            access_token: token, refresh_token: token + '-refresh',
            expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'A' },
        }));
    }
    const here = client('here-auth');
    const { logoutFlow } = loadSource<{ logoutFlow: ReturnType<typeof createLogoutFlow> }>('lib/logout.ts', {
        '@supabase/supabase-js': { isAuthApiError, isAuthSessionMissingError },
        './auth-storage': { __esModule: true, default: deps.storage },
        './logout-flow': { createLogoutFlow },
        './managed-logout': { createManagedLogout },
        './device-recovery-api': { createDeviceRecoveryApi: () => ({}) },
        './session-identity': { jwtSessionId },
        './push-notifications': {
            getCurrentDeviceToken: deps.resolveToken, registerDeviceToken: deps.register, removeDeviceToken: deps.remove,
        },
        './supabase': { supabase: here },
    }, { process: { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://auth.example.test' } } });

    assert.ok((await logoutFlow.signOut()).error);
    assert.deepEqual(scopes, ['local']);
    assert.equal((await here.auth.getSession()).data.session?.access_token, hereToken);
    assert.equal(await logoutFlow.canUseSession(), false);
    fail = false;
    assert.equal((await logoutFlow.signOut()).error, null);
    assert.deepEqual(scopes, ['local', 'local', 'local']);
    assert.deepEqual([...revoked], ['Bearer ' + hereToken]);
    assert.equal((await client('here-auth').auth.getSession()).data.session, null);
    assert.equal((await client('other-auth').auth.getSession()).data.session?.access_token, 'a-other');
});
}

test('the PostgREST adapter sends a DELETE with both exact filters and the original session bearer', async () => {
    const token = 'ExponentPushToken[test]';
    let requests = 0;
    const transport: typeof fetch = async (input, init) => {
        requests++;
        assert.equal(init?.method, 'DELETE');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer a-here');
        const url = new URL(String(input));
        assert.equal(url.pathname, '/rest/v1/user_device_tokens');
        assert.equal(url.searchParams.get('user_id'), 'eq.A');
        const filter = url.searchParams.get('expo_push_token');
        if (filter === 'eq.empty404') return new Response(null, { status: 404 });
        if (filter === 'eq.array404') return new Response('[]', { status: 404 });
        assert.equal(filter, 'eq.' + token);
        return new Response(null, { status: 204 });
    };
    const { removeDeviceToken } = loadSource<{ removeDeviceToken(session: LogoutSession, token: string): Promise<void> }>(
        'lib/push-notifications.ts', {
            'expo-constants': {}, 'expo-device': {}, 'expo-notifications': { setNotificationHandler() {} },
            'react-native': {}, './free-end-action': {},
            './supabase': {
                createSessionDataClient: (bearer: string, requestFetch?: typeof fetch) => createClient('https://data.example.test', 'test-key', {
                    accessToken: async () => bearer,
                    global: { fetch: requestFetch ?? transport },
                }),
            },
        }, { fetch: transport },
    );
    const session = { user: { id: 'A' }, access_token: 'a-here' };
    await Promise.all([
        removeDeviceToken(session, token),
        assert.rejects(removeDeviceToken(session, 'empty404'), /outcome is unknown/),
        assert.rejects(removeDeviceToken(session, 'array404'), /outcome is unknown/),
    ]);
    assert.equal(requests, 3);
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

test('corrupt or mismatched logout records cannot skip revocation or overwrite storage', async () => {
    const markers = ['{', 'null', '[]', '{"userId":"A","sessionId":"a-here","revoked":"false"}',
        '{"userId":"A","revoked":true}', '{"sessionId":"a-here","revoked":true}',
        '{"userId":"A","sessionId":"a-other","revoked":true}', '{"userId":"B","sessionId":"a-here","revoked":true}'];
    for (const raw of markers) {
        const { deps, flow, events } = fixture();
        await deps.storage.setItem('test:logout', raw);
        deps.revoke = async () => assert.fail('cannot revoke using a corrupt or mismatched record');
        assert.ok((await flow.signOut()).error, raw);
        assert.equal(await deps.storage.getItem('test:logout'), raw);
        assert.deepEqual(events, []);
    }
});

test('corrupt Push registration is preserved instead of resolving or deleting any token', async () => {
    const { deps, flow, events } = fixture();
    const raw = '{"tokens":["here"],"pending":"true"}';
    await deps.storage.setItem('test:push:A', raw);
    deps.resolveToken = async () => assert.fail('cannot replace a corrupt record using the current token');
    assert.match((await flow.signOut()).error!.message, /Invalid device registration record/);
    assert.equal(await deps.storage.getItem('test:push:A'), raw);
    assert.deepEqual(events, []);
});

test('revoked checkpoint does not discard a corrupt or uncertain Push registration on restart', async () => {
    for (const [raw, expected] of [['null', /Invalid device registration record/],
        ['{"tokens":["here"],"pending":true}', /registration outcome is unknown/]] as const) {
        const { deps, events } = fixture();
        deps.session = async () => null;
        const checkpoint = '{"userId":"A","sessionId":"a-here","revoked":true}';
        await deps.storage.setItem('test:logout', checkpoint);
        await deps.storage.setItem('test:push:A', raw);
        assert.match((await createLogoutFlow(deps).signOut()).error!.message, expected);
        assert.equal(await deps.storage.getItem('test:logout'), checkpoint);
        assert.equal(await deps.storage.getItem('test:push:A'), raw);
        assert.deepEqual(events, []);
    }
});

test('a fresh logout without a session does not write a marker', async () => {
    const { deps, flow } = fixture();
    deps.session = async () => null;
    deps.storage.setItem = async () => assert.fail('must not write a marker');
    deps.storage.removeItem = async () => assert.fail('must not remove a marker');
    assert.equal((await flow.signOut()).error, null);
});

for (const rejected of [false, true]) {
    test(`repairs registration storage after a known ${rejected ? 'rejection' : 'success'}`, async () => {
        const { deps, flow, rows } = fixture();
        const write = deps.storage.setItem;
        const remove = deps.storage.removeItem;
        deps.storage.setItem = async (key, value) => {
            if (key.endsWith(':push:A') && JSON.parse(value).pending === false) throw new Error('write failed');
            await write(key, value);
        };
        deps.storage.removeItem = async key => {
            if (key.endsWith(':push:A')) throw new Error('remove failed');
            await remove(key);
        };
        if (rejected) deps.register = async () => ({ rejected: new Error('rejected') });
        await assert.rejects(flow.save('A', 'here'));
        deps.storage.setItem = write;
        deps.storage.removeItem = remove;
        assert.equal((await flow.signOut()).error, null);
        assert.equal(rows.has('here'), false);
    });
}

test('retries persisting confirmed Auth revocation after the local session disappears', async () => {
    const { deps, flow } = fixture();
    const write = deps.storage.setItem;
    let revocations = 0;
    deps.revoke = async () => { revocations++; };
    deps.storage.setItem = async (key, value) => {
        if (key === 'test:logout' && JSON.parse(value).revoked) throw new Error('checkpoint failed');
        await write(key, value);
    };
    assert.match((await flow.signOut()).error!.message, /checkpoint/);
    deps.session = async () => null;
    assert.ok((await createLogoutFlow(deps).signOut()).error);
    deps.storage.setItem = write;
    assert.equal((await flow.signOut()).error, null);
    assert.equal(revocations, 1);
});

function layoutFixture(flow: ReturnType<typeof createLogoutFlow>) {
    const effects: (() => void)[] = [];
    type Element = { type: unknown; props: { onPress?: () => void; key?: string } | null; children: Element[] };
    const state: unknown[] = [{ user: { id: 'A' }, access_token: hereToken }, false, null, false, 0];
    let index = 0;
    const react = {
        useState: () => {
            const slot = index++;
            return [state[slot], (value: unknown) => {
                state[slot] = typeof value === 'function' ? value(state[slot]) : value;
            }];
        },
        useEffect: (effect: () => void) => { effects.push(effect); },
        useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
        createElement: (type: unknown, props: Element['props'], ...children: Element[]) => ({ type, props, children }),
    };
    const { default: renderLayout } = loadSource<{ default(): Element }>('app/_layout.tsx', {
        react, 'expo-notifications': {}, 'expo-status-bar': {}, 'react-native-reanimated': {},
        'expo-router': { Stack: { Protected: 'protected' } },
        'react-native': { Button: 'retry', ActivityIndicator: 'spinner', StyleSheet: { create: (value: unknown) => value } },
        '@/lib/push-notifications': {}, '@/components/themed-text': { ThemedText: 'text' },
        '@/components/themed-view': { ThemedView: 'view' }, '@/hooks/use-color-scheme': { useColorScheme: () => 'light' },
        '@/lib/notification-task': {}, '@/lib/logout': { logoutFlow: flow }, '@/lib/supabase': { supabase: {} },
        '@/lib/session-identity': { jwtSessionId },
    }, { React: react });
    return {
        effects,
        render() {
            index = 0;
            effects.length = 0;
            return renderLayout();
        },
        retryAttempt: () => state[4],
    };
}

test('a transient startup storage failure blocks routes without signing out, and can be rechecked', async () => {
    const { deps, flow, events, rows } = fixture();
    const read = deps.storage.getItem;
    let failed = false;
    deps.storage.getItem = async key => {
        if (!failed && key === 'test:logout') {
            failed = true;
            throw new Error('temporary storage failure');
        }
        return read(key);
    };
    const { render, effects, retryAttempt } = layoutFixture(flow);
    render();
    effects[1]();
    await setImmediate();
    assert.deepEqual(events, []);
    assert.equal((await deps.session())?.access_token, hereToken);
    assert.equal(rows.get('here'), 'A');
    const view = render().children[0];
    assert.equal(view.type, 'view');
    assert.equal(view.children[1].type, 'retry');
    view.children[1].props?.onPress?.();
    assert.equal(retryAttempt(), 1);
    render();
    effects[1]();
    await setImmediate();
    assert.equal(render().children[0].props?.key, 'A:a-here');
    assert.deepEqual(events, []);
});

test('restored session resumes logout and keeps routes blocked while the retry action is available', async () => {
    const { deps, events } = fixture();
    await deps.storage.setItem('test:logout', JSON.stringify({ userId: 'A', sessionId: 'a-here' }));
    const flow = createLogoutFlow(deps);
    const remove = deps.remove;
    deps.remove = async () => { throw new Error('network'); };
    const { render, effects } = layoutFixture(flow);
    render();
    effects[1]();
    await setImmediate();
    assert.equal(flow.getError()?.message, 'network');
    const tree = render();
    const view = tree.children[0];
    assert.equal(view.type, 'view');
    assert.equal(view.children[0].type, 'text');
    assert.equal(view.children[1].type, 'retry');
    deps.remove = remove;
    const retry = view.children[1].props?.onPress;
    assert.ok(retry);
    retry();
    retry();
    await setImmediate();
    assert.equal(flow.isBlocked(), false);
    assert.deepEqual(events, ['delete:here', 'auth']);
});

test('a cutoff or marker cleanup write failure can resume after restart with revocation confirmed', async () => {
    for (const failure of ['cutoff', 'marker']) {
        const { deps, flow, events } = fixture();
        const write = deps.storage.setItem;
        const remove = deps.storage.removeItem;
        deps.storage.setItem = async (key, value) => {
            if (failure === 'cutoff' && key.endsWith(':notification-cutoff')) throw new Error(failure);
            await write(key, value);
        };
        deps.storage.removeItem = async key => {
            if (failure === 'marker' && key === 'test:logout') throw new Error(failure);
            await remove(key);
        };
        assert.equal((await flow.signOut()).error?.message, failure);
        deps.storage.setItem = write;
        deps.storage.removeItem = remove;
        const restarted = createLogoutFlow(deps);
        assert.equal(await restarted.canUseSession(), false);
        assert.equal((await restarted.signOut()).error, null);
        assert.deepEqual(events, ['delete:here', 'auth']);
    }
});

test('rejects notifications received during the first logout after account switch', async (t) => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const { deps, flow, setSession } = fixture();
    const entered = deferred<void>();
    const proceed = deferred<void>();
    deps.revoke = async () => { entered.resolve(); await proceed.promise; };
    const operation = flow.signOut();
    await entered.promise;
    assert.equal(await flow.canUseNotification(1100), false);
    now = 1200;
    proceed.resolve();
    assert.equal((await operation).error, null);
    setSession({ user: { id: 'B' }, access_token: 'b-here' });
    const restarted = createLogoutFlow(deps);
    assert.equal(await restarted.canUseNotification(1100), false);
    assert.equal(await restarted.canUseNotification(1200), false);
    assert.equal(await restarted.canUseNotification(1201), true);
    now = 1250;
    await restarted.authenticate(async () => {});
    assert.equal(await restarted.canUseNotification(1249), false);
    assert.equal(await restarted.canUseNotification(1251), true);
});

test('registration adapter distinguishes SQL rollback from gateway and transport failures', async () => {
    let response: { status: number; error: { code: string; message: string; hint?: null; details?: null } };
    const { registerDeviceToken } = loadSource<{
        registerDeviceToken(session: LogoutSession, token: string): Promise<{ rejected: Error | null }>;
    }>('lib/push-notifications.ts', {
        'expo-constants': {}, 'expo-device': {}, 'expo-notifications': { setNotificationHandler() {} },
        'react-native': { Platform: { OS: 'android' } }, './free-end-action': {},
        './supabase': { createSessionDataClient: () => ({ rpc: () => ({ retry: () => Promise.resolve(response) }) }) },
    });
    const session = { user: { id: 'A' }, access_token: 'a-here' };
    response = { status: 500, error: { code: '57014', message: 'canceling statement due to statement timeout',
        details: null, hint: null } };
    assert.match((await registerDeviceToken(session, 'here')).rejected!.message, /statement timeout/);
    for (const [status, code] of [[503, 'PGRST000'], [503, 'PGRST002'], [504, 'PGRST003']] as const) {
        response = { status, error: { code, message: 'request not executed', details: null, hint: null } };
        assert.match((await registerDeviceToken(session, 'here')).rejected!.message, /not executed/);
    }
    for (const status of [0, 502, 504]) {
        response = { status, error: { code: '', message: 'no definitive reply' } };
        await assert.rejects(registerDeviceToken(session, 'here'), /outcome is unknown/);
    }
    response = { status: 504, error: { code: '57014', message: 'gateway timeout', details: null, hint: null } };
    await assert.rejects(registerDeviceToken(session, 'here'), /outcome is unknown/);
    for (const [status, code] of [[503, 'PGRST001'], [503, 'PGRST003'], [504, '']] as const) {
        response = { status, error: { code, message: 'uncertain connection result', details: null, hint: null } };
        await assert.rejects(registerDeviceToken(session, 'here'), /outcome is unknown/);
    }
});

test('extension exceptions suppress the old session result while preserving eligible server errors', async () => {
    for (const mode of ['fetch', 'body'] as const) {
        for (const invalidated of [false, true]) {
            let eligible = true;
            const extend = createExtendClient({
                apiUrl: 'https://api.example.test',
                getAccessToken: async () => hereToken,
                canUseToken: async () => eligible,
                onChanged: () => assert.fail('failed requests must not change state'),
                fetch: async () => {
                    const reject = () => { eligible = !invalidated; throw new Error('network failed'); };
                    if (mode === 'fetch') return reject();
                    const response = new Response();
                    response.json = async () => reject();
                    return response;
                },
            });
            assert.deepEqual(await extend('/profiles/me/is-free/extend-from-notification'), {
                ok: false, reason: invalidated ? 'not-authenticated' : 'server-error',
            });
        }
    }
});

for (const scenario of ['token refresh', 'same-user session replacement', 'session replacement during the storage check']) {
    test(`notification extension handles ${scenario}`, async () => {
        const sameSession = scenario === 'token refresh';
        const switchDuringCheck = scenario === 'session replacement during the storage check';
        const jwt = (sessionId: string, counter: number) =>
            'header.' + Buffer.from(JSON.stringify({ session_id: sessionId, counter, name: 'テスト' })).toString('base64url') + '.sig';
        const session = { user: { id: 'A' }, access_token: jwt('session-1', 1) };
        const { flow } = fixture();
        let responseReceived = false;
        let responseChecks = 0;
        let updates = 0;
        const { extendFreeFromNotification } = loadSource<{
            extendFreeFromNotification(id: string, date: number): Promise<unknown>;
        }>('lib/extend-free.ts', {
            './supabase': { supabase: { auth: { getSession: async () => ({ data: { session: { ...session } } }) } } },
            './availability-events': { notifyAvailabilityChanged: () => { updates++; } },
            './free-end-action': { createExtendClient },
            './logout': { logoutFlow: {
                ...flow,
                async canUseNotification(date: number) {
                    const allowed = await flow.canUseNotification(date);
                    if (switchDuringCheck && responseReceived && ++responseChecks === 2) {
                        session.access_token = jwt('session-2', 2);
                    }
                    return allowed;
                },
            } },
            './session-identity': { jwtSessionId },
        }, {
            process: { env: { EXPO_PUBLIC_API_URL: 'https://api.example.test' } },
            fetch: async () => {
                if (!switchDuringCheck) session.access_token = jwt(sameSession ? 'session-1' : 'session-2', 2);
                responseReceived = true;
                return Response.json({ is_free: true, free_until: '2026-11-24T00:00:00Z' });
            },
        });
        assert.deepEqual(await extendFreeFromNotification('claim', Date.now()), sameSession
            ? { ok: true, freeUntil: '2026-11-24T00:00:00Z' }
            : { ok: false, reason: 'not-authenticated' });
        assert.equal(updates, sameSession ? 1 : 0);
    });
}

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
