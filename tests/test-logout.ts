import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { AuthApiError, AuthRetryableFetchError, isAuthApiError, isAuthSessionMissingError } from '@supabase/supabase-js';
import { createExtendClient } from '../lib/free-end-action';
import { createLogoutFlow, type LogoutSession } from '../lib/logout-flow';
import { createManagedLogout, type ManagedDeviceApi } from '../lib/managed-logout';
import { jwtSessionId } from '../lib/session-identity';
import { loadSource } from './helpers/load-source';

function sessionToken(sessionId: string) {
    return 'header.' + Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url') + '.sig';
}

const hereToken = sessionToken('a-here');

function managedFixture(fresh = false) {
    const userId = '01000000-0000-0000-0000-000000000001';
    const sessionId = '02000000-0000-0000-0000-000000000002';
    const installationId = '03000000-0000-0000-0000-000000000003';
    const recoveryId = '04000000-0000-0000-0000-000000000004';
    const stored = new Map<string, string>();
    const events: string[] = [];
    const a = { user: { id: userId }, access_token: sessionToken(sessionId) };
    let current: LogoutSession | null = a;
    let authPresent = true, fenced = false, acked = false;
    let fail = '', keyAvailable = true, initialized = !fresh;
    if (initialized) stored.set('test:device-v2-clean', installationId);
    let operations = 0;
    const failOnce = (name: string) => {
        if (fail === name) { fail = ''; throw new Error('interrupted ' + name); }
    };
    const api: ManagedDeviceApi = {
        validateConfiguration() {},
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
            const journal = JSON.parse(stored.get('test:logout-v2-intent')!);
            assert.equal(journal.operationId, entry.operationId);
            assert.equal(journal.registration, undefined);
            assert.equal(journal.access_token, undefined);
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
            if (action !== 'ack') throw new Error('Automatic recovery is disabled');
            if (action === 'ack') {
                assert.equal(authPresent, false);
                assert.equal(current, null);
                assert.equal(stored.has('test:notification-cutoff'), true);
                assert.equal(JSON.parse(stored.get('test:logout-v2')!).stage, 'ack');
                acked = true;
            }
            failOnce(action);
            return { recoveryId, status: acked ? 'cleared' : 'pending' };
        },
    };
    const storage = {
        async getItem(key: string) { failOnce('read:' + key); return stored.get(key) ?? null; },
        async setItem(key: string, value: string) { failOnce('write:' + key); stored.set(key, value); },
        async removeItem(key: string) { failOnce('remove:' + key); stored.delete(key); },
    };
    function restart(recoverySession?: () => Promise<LogoutSession | null>) {
        const session = async () => current;
        return createLogoutFlow({
            storage, prefix: "test", session,
            managed: createManagedLogout({
                storage, session, recoverySession, api, prefix: 'test',
                async revoke(session) {
                    assert.equal(session, a);
                    events.push('revoke');
                    failOnce('before-revoke');
                    authPresent = false;
                    failOnce('revoke');
                },
                async clean() { assert.equal(authPresent, false); events.push('clear'); current = null; failOnce('clear'); },
            }),
        });
    }
    return { stored, events, a, restart, failAt: (name: string) => { fail = name; },
        replaceSession: (session: LogoutSession | null) => { current = session; },
        loseAuth: () => { current = null; authPresent = false; },
        loseKey: () => { keyAvailable = false; }, api };
}

for (const fault of ['begin', 'clear', 'ack', 'write:test:logout-v2',
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
        let authStarted = false;
        await assert.rejects(resumed.authenticate(async () => { authStarted = true; }));
        assert.equal(authStarted, false);
        assert.deepEqual(await resumed.signOut(), { error: null });
        assert.equal(stored.has('test:logout-v2'), false);
        assert.equal(stored.has('test:logout-v2-intent'), false);
        assert.equal(stored.has('test:device-v2'), false);
        assert.equal(events.indexOf('clear') > events.indexOf('revoke'), true);
        assert.equal(events.indexOf('ack') > events.indexOf('clear'), true);
        assert.equal(new Set(events.filter(event => event.startsWith('begin:'))).size, 1);
    });
}

test('managed logout retries a lost Auth reply without independent confirmation', async () => {
    const { a, events, restart, failAt } = managedFixture();
    const flow = restart();
    failAt('register');
    await assert.rejects(flow.save(a.user.id, 'test-push'));
    failAt('revoke');
    assert.ok((await flow.signOut()).error);
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.equal(events.filter(event => event === 'register').length, 1);
    assert.equal(events.includes('confirm'), false);
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

test('logout never creates a generation to resolve a lost generation-opening reply', async () => {
    const { a, events, restart, failAt } = managedFixture();
    const flow = restart();
    failAt('open');
    await assert.rejects(flow.save(a.user.id, 'test-push'));
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.equal(events.filter(event => event === 'open').length, 1);
    assert.ok(events.includes('revoke'));
});

test('a known recovery ID does not unlock while the lost JWT still has a live Auth row', async () => {
    const { a, restart, events, failAt, replaceSession } = managedFixture();
    const flow = restart();
    await flow.save(a.user.id, 'test-push');
    failAt('before-revoke');
    assert.match((await flow.signOut()).error!.message, /interrupted before-revoke|Logout session unavailable/);
    replaceSession(null);
    assert.match((await restart().signOut()).error!.message, /interrupted before-revoke|Logout session unavailable/);
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
    assert.match((await resumed.signOut()).error!.message, /no (?:verified local scope|local binding)/);
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
        URL, AbortController, setTimeout, clearTimeout, __DEV__: true,
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
    const devApi = createDeviceRecoveryApi('http://10.0.2.2:3000', 'https://auth.example.test');
    const beforeHttp = requests.length;
    await assert.rejects(devApi.begin(session, { installationId: id, sessionId: id, userId: id,
        operationId: id, generation: '1' }), /Secure device recovery API required/);
    assert.equal(requests.length, beforeHttp);
    assert.equal((await devApi.recovery(id, 'confirm', recoveryId)).status, 'confirmed');
    assert.ok(requests.slice(beforeHttp).every(r => !r.headers.authorization));
});

test('getCurrentSession distinguishes missing setup from an existing logout block', async () => {
    for (const configured of [false, true]) {
        const { getCurrentSession } = loadSource<{
            getCurrentSession(): Promise<{ session: unknown; error: Error | null }>;
        }>('lib/auth.ts', {
            './logout': { logoutFlow: { revision: () => 0, sessionAvailability: async () => 'logout-pending' } },
            './supabase': { supabase: configured ? { auth: {
                getSession: async () => assert.fail('Logout block must prevent session lookup'),
            } } : null },
        });
        const result = await getCurrentSession();
        assert.equal(result.session, null);
        if (configured) assert.equal(result.error, null);
        else assert.match(result.error?.message ?? '', /EXPO_PUBLIC_SUPABASE_URL/);
    }
});

test('logout recovery rechecks definitive refresh rejection and keeps other read errors blocked', async () => {
    type SessionRead = { data: { session: LogoutSession | null }; error: AuthApiError | AuthRetryableFetchError | null };
    function adapter(reads: SessionRead[]) {
        let options!: Parameters<typeof createManagedLogout>[0] & { recoverySession?: () => Promise<LogoutSession | null> };
        let readsUsed = 0;
        loadSource('lib/logout.ts', {
            '@supabase/supabase-js': { isAuthApiError, isAuthSessionMissingError },
            './auth-storage': {},
            './logout-flow': { createLogoutFlow() {} },
            './managed-logout': { createManagedLogout(value: typeof options) { options = value; } },
            './device-recovery-api': { createDeviceRecoveryApi() {} },
            './session-identity': { jwtSessionId },
            './supabase': { supabase: { auth: {
                async getSession() {
                    const read = reads[readsUsed++];
                    assert.ok(read);
                    return read;
                },
                async signOut() { assert.fail('Must not sign out another session'); },
            } } },
        }, { process: { env: {} } });
        return { options, recover: options.recoverySession ?? options.session, count: () => readsUsed };
    }
    const empty = { data: { session: null }, error: null };
    const failure = (error: NonNullable<SessionRead['error']>) => ({ ...empty, error });
    for (const code of ['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used']) {
        const terminal = new AuthApiError('Refresh refused', 400, code);
        const safe = adapter([failure(terminal), empty]);
        assert.equal(await safe.recover(), null);
        assert.equal(safe.count(), 2);
        const ordinary = adapter([failure(terminal), empty]);
        await assert.rejects(ordinary.options.session(), error => error === terminal);
        assert.equal(ordinary.count(), 1);
    }
    const network = new AuthRetryableFetchError('Request failed', 503);
    const terminal = new AuthApiError('Refresh refused', 400, 'refresh_token_not_found');
    for (const error of [network, new AuthApiError('Unexpected Auth error', 403, 'bad_jwt')]) {
        const uncertain = adapter([failure(error), empty]);
        await assert.rejects(uncertain.recover(), actual => actual === error);
        assert.equal(uncertain.count(), 1);
    }
    const disrupted = adapter([failure(terminal), failure(network)]);
    await assert.rejects(disrupted.recover(), error => error === network);
    const substituted = adapter([failure(terminal), { data: { session: {
        user: { id: 'other' }, access_token: sessionToken('other'),
    } }, error: null }]);
    await assert.rejects(substituted.options.clean({ installationId: 'device', userId: 'original', sessionId: 'original' }),
        /Logout session changed/);

    const { a, restart, failAt, events, replaceSession, loseAuth } = managedFixture();
    const flow = restart();
    await flow.save(a.user.id, 'test-push');
    failAt('before-revoke');
    assert.match((await flow.signOut()).error?.message ?? '', /interrupted before-revoke|Logout session unavailable/);
    replaceSession(null);
    const recovered = adapter([failure(terminal), empty, empty]);
    assert.match((await restart(recovered.recover).signOut()).error?.message ?? '', /interrupted before-revoke|Logout session unavailable/);
    assert.equal(recovered.count(), 2);
    assert.ok(!events.includes('ack'));
    loseAuth();
    assert.ok((await restart().signOut()).error);
    assert.equal(events.includes('ack'), false);
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
        const flow = { canUseNotification: async (_date: number) => true, revision: () => 0 };
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


test('a managed session without Push permission initializes its key and logs out without creating a generation', async () => {
    const { restart, events, a, replaceSession } = managedFixture(true);
    replaceSession(null);
    const flow = restart();
    await flow.authenticate(async () => { replaceSession(a); });
    assert.equal(events.length, 0);
    await flow.prepareSession(a);
    assert.deepEqual(events, ['ensure-key']);
    assert.equal((await flow.signOut()).error, null);
    assert.equal(events.includes('open'), false);
    assert.equal(events.includes('register'), false);
    assert.ok(events.includes('ack'));
});

test('unavailable hardware is rejected before invoking authentication', async () => {
    const { restart, replaceSession, loseKey } = managedFixture(true);
    replaceSession(null);
    loseKey();
    let started = false;
    await assert.rejects(restart().authenticate(async () => { started = true; }));
    assert.equal(started, false);
});

test('sign-in reports Auth success and retries device setup for the same restored session', async () => {
    const { restart, events, a, replaceSession, failAt } = managedFixture(true);
    replaceSession(null);
    const flow = restart();
    let authCalls = 0;
    const { signInUser } = loadSource<{
        signInUser(email: string, password: string): Promise<{ session: LogoutSession | null; error: Error | null }>;
    }>('lib/auth.ts', {
        './logout': { logoutFlow: flow },
        './supabase': { supabase: { auth: { async signInWithPassword() {
            authCalls++;
            replaceSession(a);
            return { data: { session: a }, error: null };
        } } } },
    });
    failAt('ensure-key');
    const result = await signInUser('user@example.test', 'test-password');
    assert.equal(result.session, a);
    assert.equal(result.error, null);
    await assert.rejects(flow.prepareSession(a), /interrupted ensure-key/);
    await restart().prepareSession(a);
    assert.equal(authCalls, 1);
    assert.deepEqual(events, ['ensure-key', 'ensure-key']);
});

const notificationBlockKey = 'test:notification-auth-pending';
test('Auth never starts when the durable notification block cannot be written', async () => {
    const { restart, failAt, replaceSession } = managedFixture(true);
    replaceSession(null);
    failAt('write:' + notificationBlockKey);
    await assert.rejects(restart().authenticate(() => assert.fail('Auth ran')), /notification-auth-pending/);
});

test('a restarted notification runtime blocks even a registered session while cutoff is pending', async () => {
    const { restart, a, stored } = managedFixture();
    await restart().save(a.user.id, 'test-push');
    assert.equal(await restart().canUseNotification(Date.now()), true);
    stored.set(notificationBlockKey, 'pending');
    assert.equal(await restart().canUseNotification(Date.now()), false);
});

for (const fault of [null, 'write:test:notification-cutoff', 'remove:' + notificationBlockKey]) {
    test(`old notifications stay blocked across account switch and restart after ${fault ?? 'Auth'}`, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: 1000 });
        const { restart, stored, a, replaceSession, failAt } = managedFixture();
        const flow = restart();
        await flow.save(a.user.id, 'test-push');
        assert.equal((await flow.signOut()).error, null);
        const b = { user: { id: randomUUID() }, access_token: sessionToken(randomUUID()) };
        await flow.authenticate(async () => {
            assert.equal(stored.get(notificationBlockKey), 'pending');
            replaceSession(b);
        });
        t.mock.timers.setTime(2000);
        if (fault) {
            failAt(fault);
            await assert.rejects(flow.prepareSession(b), /interrupted/);
        }
        assert.equal(stored.get(notificationBlockKey), 'pending');
        const resumed = restart();
        assert.equal(await resumed.canUseNotification(1500), false);
        assert.equal(await resumed.canUseNotification(2500), false);
        await assert.rejects(resumed.prepareSession(a), /Device session changed/);
        assert.equal(stored.get(notificationBlockKey), 'pending');
        t.mock.timers.setTime(3000);
        await resumed.prepareSession(b);
        await resumed.save(b.user.id, 'test-push');
        assert.equal(stored.has(notificationBlockKey), false);
        assert.equal(await resumed.canUseNotification(1500), false);
        assert.equal(await resumed.canUseNotification(3000), false);
        assert.equal(await resumed.canUseNotification(3001), true);
    });
}

test('an existing session without a key cannot re-enroll as a new installation', async () => {
    const { restart, api, a, events } = managedFixture(true);
    const identity = api.identity;
    api.identity = async create => {
        assert.equal(create, false);
        return identity(create);
    };
    const flow = restart();
    assert.equal(await flow.sessionAvailability(), 'read-failed');
    await flow.save(a.user.id, 'ExpoPushToken[unused]');
    assert.match((await flow.signOut()).error?.message ?? '', /key is unavailable/);
    assert.deepEqual(events, []);
});

test('storage read failure does not revoke the signed-in session', async () => {
    const { restart, events, failAt, a } = managedFixture();
    const flow = restart();
    await flow.prepareSession(a);
    failAt('read:test:logout-v2');
    assert.equal(await flow.sessionAvailability(), 'read-failed');
    assert.deepEqual(events, ['ensure-key']);
    assert.equal(await flow.sessionAvailability(), 'ready');
});

test('logout shares one operation and waits for in-flight token registration', async () => {
    const { restart, events, api, a } = managedFixture();
    const flow = restart();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const register = api.register;
    api.register = async (...args) => {
        entered.resolve();
        await release.promise;
        return register(...args);
    };
    const saving = flow.save(a.user.id, 'ExpoPushToken[managed]');
    await entered.promise;
    const leaving = flow.signOut();
    assert.equal(flow.signOut(), leaving);
    assert.equal(await flow.canUseSession(), false);
    assert.equal(events.some(event => event.startsWith('begin:')), false);
    release.resolve();
    await saving;
    assert.equal((await leaving).error, null);
    assert.equal(events.filter(event => event.startsWith('begin:')).length, 1);
});


test('corrupt logout records remain blocked without discovery or account cleanup', async () => {
    const { a, stored, restart, events, failAt } = managedFixture();
    await restart().save(a.user.id, 'test-push');
    failAt('begin');
    assert.ok((await restart().signOut()).error);
    stored.set('test:logout-v2', '{broken');
    assert.ok((await restart().signOut()).error);
    assert.equal(events.includes('discover-binding'), false);
    assert.equal(events.includes('clear'), false);
});

test('a corrupt cutoff is superseded only by a successful completion write', async () => {
    const { a, stored, restart, failAt, events } = managedFixture();
    await restart().save(a.user.id, 'test-push');
    stored.set('test:notification-cutoff', 'corrupt');
    failAt('write:test:notification-cutoff');
    assert.ok((await restart().signOut()).error);
    assert.equal(stored.get('test:notification-cutoff'), 'corrupt');
    assert.equal(await restart().canUseNotification(Date.now() + 10000), false);
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.ok(Number.isSafeInteger(Number(stored.get('test:notification-cutoff'))));
    assert.equal(events.includes('confirm'), false);
});

test('session read failure is returned as an error, never as a normal signed-out result', async () => {
    const { getCurrentSession } = loadSource<typeof import('../lib/auth')>('lib/auth.ts', {
        './logout': { logoutFlow: { revision: () => 0, sessionAvailability: async () => 'read-failed' } },
        './supabase': { supabase: { auth: { getSession: async () => assert.fail('blocked read') } } },
    });
    const result = await getCurrentSession();
    assert.equal(result.session, null);
    assert.match(result.error?.message ?? '', /Session state unavailable/);
});


test('logout request survives restart before in-flight registration drains', async () => {
    const { restart, api, a, stored, events } = managedFixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    api.register = async () => { entered.resolve(); await release.promise; };
    const flow = restart();
    const saving = flow.save(a.user.id, 'ExpoPushToken[waiting]');
    await entered.promise;
    const leaving = flow.signOut();
    try {
        await new Promise(resolve => setImmediate(resolve));
        const raw = stored.get('test:logout-v2-request');
        assert.ok(raw, 'logout request must be durable before the registration wait');
        const request = JSON.parse(raw);
        assert.equal(request.userId, a.user.id);
        assert.equal(request.sessionId, jwtSessionId(a.access_token));
        assert.equal(request.access_token, undefined);
        assert.equal(await restart().sessionAvailability(), 'logout-pending');
        assert.equal(events.some(event => event.startsWith('begin:')), false);
    } finally {
        release.resolve(); await saving; await leaving;
    }
    assert.equal(stored.has('test:logout-v2-request'), false);
});


test('a completed clean installation can repeat logout without creating an unscoped request', async () => {
    const { restart, replaceSession, stored } = managedFixture();
    replaceSession(null);
    assert.deepEqual(await restart().signOut(), { error: null });
    assert.equal(stored.has('test:logout-v2-request'), false);
});


test('restart resumes a persisted logout while the old registration response is still pending', async () => {
    const { restart, api, a, stored } = managedFixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    api.register = async () => { entered.resolve(); await release.promise; };
    const flow = restart();
    const saving = flow.save(a.user.id, 'ExpoPushToken[waiting]');
    await entered.promise;
    const leaving = flow.signOut();
    try {
        await new Promise(resolve => setImmediate(resolve));
        const next = restart();
        assert.equal(await next.sessionAvailability(), 'logout-pending');
        assert.deepEqual(await next.signOut(), { error: null });
        assert.equal(stored.has('test:logout-v2-request'), false);
    } finally { release.resolve(); await saving; await leaving; }
    assert.equal(stored.has('test:device-v2'), false);
});

test('logout persists its target before waiting for device provisioning', async () => {
    const { restart, api, a, stored } = managedFixture();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const ensure = api.ensureInstallation;
    api.ensureInstallation = async (...args) => { entered.resolve(); await release.promise; return ensure(...args); };
    const flow = restart();
    const preparing = flow.prepareSession(a).catch(error => error as Error);
    await entered.promise;
    const leaving = flow.signOut();
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(JSON.parse(stored.get('test:logout-v2-request')!).sessionId, jwtSessionId(a.access_token));
        assert.equal(await restart().sessionAvailability(), 'logout-pending');
    } finally {
        release.resolve();
        assert.match((await preparing as Error).message, /Device session changed/);
        await leaving;
    }
});

test('failed logout request persistence stops before any server invalidation', async () => {
    const { restart, a, failAt, events } = managedFixture();
    const flow = restart(); await flow.prepareSession(a);
    failAt('write:test:logout-v2-request');
    assert.ok((await flow.signOut()).error);
    assert.equal(events.some(event => event.startsWith('begin:')), false);
    assert.equal(events.includes('revoke'), false);
    assert.equal(flow.isBlocked(), true);
    assert.deepEqual(await flow.signOut(), { error: null });
});


test('review45 rejects an insecure authenticated endpoint before Auth even with a clean installation', async () => {
    const { createDeviceRecoveryApi } = loadSource<{ createDeviceRecoveryApi: typeof import('../lib/device-recovery-api').createDeviceRecoveryApi }>(
        'lib/device-recovery-api.ts', {
            'expo-modules-core': { uuid: { v4: randomUUID } }, 'react-native': { Platform: { OS: 'android' } },
            './session-identity': { jwtSessionId },
        }, { URL, __DEV__: true });
    assert.doesNotThrow(() => createDeviceRecoveryApi('https://express.example.test', 'https://auth.example.test').validateConfiguration());
    for (const endpoint of ['http://10.0.2.2:3000', 'http://127.0.0.1:3000']) {
        const { api, restart, replaceSession } = managedFixture();
        // Use the production configuration validator with no network/native calls.
        api.validateConfiguration = () => createDeviceRecoveryApi(endpoint, 'https://auth.example.test').validateConfiguration();
        replaceSession(null);
        let started = false;
        await assert.rejects(restart().authenticate(async () => { started = true; }), /Secure device recovery API/);
        assert.equal(started, false);
    }
});

test('review46 rejects invalid present notification cutoffs while retaining valid and absent behavior', async () => {
    const { a, stored, restart } = managedFixture();
    const flow = restart(); await flow.save(a.user.id, 'ExpoPushToken[test]');
    for (const value of ['', '   ', '0', '-1', 'NaN', 'Infinity', '9007199254740992']) {
        stored.set('test:notification-cutoff', value);
        assert.equal(await flow.canUseNotification(Date.now()), false, JSON.stringify(value));
    }
    stored.set('test:notification-cutoff', '100');
    assert.equal(await flow.canUseNotification(100), false);
    assert.equal(await flow.canUseNotification(101), true);
    stored.delete('test:notification-cutoff');
    assert.equal(await flow.canUseNotification(undefined), true);
});

test('review47 throwing subscribers cannot trap authentication or suppress healthy listeners', async () => {
    const { restart, replaceSession } = managedFixture(); replaceSession(null);
    const flow = restart(); const transitions: boolean[] = [];
    flow.subscribe(() => { throw Error('subscriber failure'); });
    flow.subscribe(() => { transitions.push(flow.isAuthenticating()); });
    let starts = 0;
    assert.equal(await flow.authenticate(async () => ++starts), 1);
    assert.equal(flow.isAuthenticating(), false);
    assert.equal(await flow.authenticate(async () => ++starts), 2);
    assert.deepEqual(transitions, [true, false, true, false]);
});

test('review48 session substitution cannot poison the durable logout target', async () => {
    const { a, restart, replaceSession, stored, events } = managedFixture();
    await restart().prepareSession(a);
    replaceSession({ ...a, access_token: sessionToken('06000000-0000-0000-0000-000000000006') });
    assert.ok((await restart().signOut()).error);
    assert.equal(stored.has('test:logout-v2-request'), false);
    assert.equal(events.includes('revoke'), false);
    replaceSession(a);
    assert.deepEqual(await restart().signOut(), { error: null });
});

test('review49 a clean marker never proves completion of a pending scoped logout request', async () => {
    const { a, stored, restart, replaceSession } = managedFixture();
    stored.set('test:logout-v2-request', JSON.stringify({ userId: a.user.id,
        sessionId: jwtSessionId(a.access_token), operationId: randomUUID() }));
    replaceSession(null);
    const flow = restart();
    assert.ok((await flow.signOut()).error);
    assert.equal(await restart().sessionAvailability(), 'logout-pending');
    assert.equal(stored.has('test:logout-v2-request'), true);
});
