import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
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
    let authPresent = true, fenced = false, confirmed = false, acked = false;
    let fail = '', keyAvailable = true, initialized = !fresh;
    if (initialized) stored.set('test:device-v2-clean', installationId);
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
            storage, prefix: "test", session,
            managed: createManagedLogout({
                storage, session, api, prefix: 'test',
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
    await assert.rejects(restart().authenticate(async () => assert.fail('Auth must not start')));
});

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
    const { restart, events, failAt } = managedFixture();
    const flow = restart();
    await flow.prepareSession();
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
