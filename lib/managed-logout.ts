import { jwtSessionId } from './session-identity';
import type { LogoutSession } from './logout-flow';

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void> };
type Scope = { installationId: string; userId: string; sessionId: string };
type Binding = Scope & { generation?: string; keyRegistered?: boolean; openRequested?: boolean;
    registration?: { operationId: string; token: string; done: boolean } };
type Intent = Scope & { operationId: string; generation?: string };
type Journal = Intent & { stage: 'begin' | 'revoke' | 'confirm' | 'clear' | 'ack'; recoveryId?: string };
type Receipt = { recoveryId: string; status: 'pending' | 'confirmed' | 'cleared' };

export type ManagedDeviceApi = {
    validateConfiguration(): void;
    identity(create: boolean): Promise<string | null>;
    operationId(): string;
    ensureInstallation(session: LogoutSession, installationId: string): Promise<void>;
    open(session: LogoutSession, installationId: string): Promise<string>;
    lookupGeneration(session: LogoutSession, installationId: string): Promise<string | null>;
    register(session: LogoutSession, installationId: string, generation: string, operationId: string, token: string): Promise<void | 'rejected'>;
    lookupRegistration(session: LogoutSession, installationId: string, generation: string, operationId: string):
        Promise<'registered' | 'rejected' | 'unknown'>;
    begin(session: LogoutSession, intent: Intent): Promise<string>;
    recovery(installationId: string, action: 'discover' | 'discover-binding' | 'confirm' | 'ack', recoveryId?: string,
        binding?: Scope & { generation?: string; operationId?: string }): Promise<Receipt>;
};

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const generationPattern = /^[1-9][0-9]{0,18}$/;
const isUuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && uuid.test(value);
const sameScope = (a: Scope, b: Scope) => a.installationId === b.installationId && a.userId === b.userId
    && a.sessionId === b.sessionId;
const owns = (session: LogoutSession, scope: Scope) => session.user.id === scope.userId
    && jwtSessionId(session.access_token) === scope.sessionId;

function readBinding(raw: string): Binding {
    const value = JSON.parse(raw);
    if (!value || !isUuid(value.installationId) || !isUuid(value.userId) || !isUuid(value.sessionId)
        || (value.generation !== undefined && (typeof value.generation !== 'string' || !generationPattern.test(value.generation)))
        || (value.openRequested !== undefined && typeof value.openRequested !== 'boolean')
        || (value.keyRegistered !== undefined && typeof value.keyRegistered !== 'boolean')
        || (value.registration !== undefined && (!value.registration || !isUuid(value.registration.operationId)
            || typeof value.registration.token !== 'string' || typeof value.registration.done !== 'boolean'))) {
        throw new Error('Invalid managed device record');
    }
    return value;
}

function readJournal(raw: string): Journal {
    const value = readBinding(raw) as Journal;
    if (!isUuid(value.operationId)
        || !['begin', 'revoke', 'confirm', 'clear', 'ack'].includes(value.stage)
        || (value.stage === 'begin' ? value.recoveryId !== undefined : !isUuid(value.recoveryId))) {
        throw new Error('Invalid logout journal');
    }
    return value;
}

export function createManagedLogout(options: {
    storage: Storage; prefix: string; api: ManagedDeviceApi;
    session(): Promise<LogoutSession | null>;
    recoverySession?(): Promise<LogoutSession | null>;
    revoke(session: LogoutSession): Promise<void>;
    clean(scope: Scope): Promise<void>;
}) {
    const { storage, prefix, api } = options;
    const bindingKey = prefix + ':device-v2';
    const journalKey = prefix + ':logout-v2';
    const intentKey = prefix + ':logout-v2-intent';
    const requestKey = prefix + ':logout-v2-request';
    const bootstrapKey = prefix + ':device-v2-bootstrap';
    const cleanKey = prefix + ':device-v2-clean';
    const put = (key: string, value: object) => storage.setItem(key, JSON.stringify(value));
    let rejectedRegistration: { operationId: string; previous: Binding } | undefined;

    async function availability() {
        const [journal, intent, binding, request] = await Promise.all([
            storage.getItem(journalKey), storage.getItem(intentKey), storage.getItem(bindingKey), storage.getItem(requestKey),
        ]);
        if (journal !== null || intent !== null || request !== null) return 'logout-pending' as const;
        if (binding !== null) {
            let record: Binding;
            try { record = readBinding(binding); } catch { return 'logout-pending' as const; }
            const session = await options.session();
            if (!session || !owns(session, record)) return 'logout-pending' as const;
            if (await api.identity(false) !== record.installationId) return 'logout-pending' as const;
        } else {
            const installation = await api.identity(false);
            const clean = await storage.getItem(cleanKey);
            if (!installation && await options.session()) throw new Error('Managed device key is unavailable');
            if (installation && clean !== installation && !(clean === 'preflight' && !await options.session())) {
                const bootstrap = await storage.getItem(bootstrapKey);
                const session = await options.session();
                if (!session || !bootstrap || !owns(session, readBinding(bootstrap))) return 'logout-pending' as const;
            }
        }
        return 'ready' as const;
    }

    async function prepareAuthentication() {
        api.validateConfiguration();
        const installation = await api.identity(false);
        const clean = await storage.getItem(cleanKey);
        if (installation && clean === installation) return;
        if ((installation && clean !== 'preflight') || (!installation && clean !== null && clean !== 'preflight')) throw new Error('Managed installation has no local binding');
        // No server write is possible while the unauthenticated reservation exists.
        if (!installation) await storage.setItem(cleanKey, 'preflight');
        const ready = installation ?? await api.identity(true);
        if (!ready) throw new Error('Hardware-backed device key unavailable');
        await storage.setItem(cleanKey, ready);
    }

    async function initialize(session: LogoutSession, stillCurrent: () => Promise<boolean>) {
        const raw = await storage.getItem(bindingKey);
        const sessionId = jwtSessionId(session.access_token);
        if (!sessionId || !isUuid(session.user.id)) throw new Error('Invalid device session');
        const installationId = await api.identity(false);
        if (!installationId) throw new Error('Managed device key is unavailable');
        if (raw === null) {
            const bootstrap = await storage.getItem(bootstrapKey);
            if (bootstrap !== null && !owns(session, readBinding(bootstrap))) throw new Error('Device bootstrap session changed');
            if (bootstrap === null && await storage.getItem(cleanKey) !== installationId) {
                throw new Error('Managed installation has no local binding');
            }
        }
        let binding = raw === null
            ? { installationId, userId: session.user.id, sessionId } as Binding : readBinding(raw);
        if (!owns(session, binding) || binding.installationId !== installationId) throw new Error('Managed session changed');
        if (!await stillCurrent()) return;
        if (raw === null) await put(bindingKey, binding);
        if (await storage.getItem(cleanKey) !== null) await storage.removeItem(cleanKey);
        if (await storage.getItem(bootstrapKey) !== null) await storage.removeItem(bootstrapKey);
        if (!binding.keyRegistered && !binding.generation && await stillCurrent()) {
            await api.ensureInstallation(session, installationId);
            binding = { ...binding, keyRegistered: true };
            await put(bindingKey, binding);
        }
    }

    async function notificationReady() {
        const raw = await storage.getItem(bindingKey);
        const session = await options.session();
        if (!raw || !session) return false;
        const binding = readBinding(raw);
        return owns(session, binding) && Boolean(binding.generation && binding.registration?.done);
    }

    async function save(session: LogoutSession, token: string, stillCurrent: () => Promise<boolean>) {
        const raw = await storage.getItem(bindingKey);
        if (raw === null || !await stillCurrent()) return;
        let binding = readBinding(raw);
        const installationId = await api.identity(false);
        if (!installationId || binding.installationId !== installationId || !owns(session, binding)) {
            throw new Error('Managed session changed');
        }
        if (rejectedRegistration && binding.registration?.operationId === rejectedRegistration.operationId
            && !binding.registration.done && sameScope(binding, rejectedRegistration.previous)
            && binding.generation === rejectedRegistration.previous.generation) {
            binding = rejectedRegistration.previous;
            await put(bindingKey, binding);
            rejectedRegistration = undefined;
        }
        if (!binding.generation) {
            if (!await stillCurrent()) return true;
            if (!binding.keyRegistered) {
                await api.ensureInstallation(session, installationId);
                binding = { ...binding, keyRegistered: true };
                await put(bindingKey, binding);
            }
            if (!await stillCurrent()) return true;
            const found = binding.openRequested ? await api.lookupGeneration(session, installationId) : null;
            if (!await stillCurrent()) return true;
            binding = { ...binding, openRequested: true };
            await put(bindingKey, binding);
            if (!await stillCurrent()) return true;
            binding = { ...binding, generation: found ?? await api.open(session, installationId) };
            await put(bindingKey, binding);
        }
        if (!await stillCurrent()) return true;
        if (binding.registration?.token === token && binding.registration.done) return true;
        // Settle a possibly committed operation before changing its payload.
        const pending = binding.registration && !binding.registration.done ? binding.registration : null;
        if (pending) {
            const outcome = await api.lookupRegistration(session, installationId, binding.generation!, pending.operationId);
            if (!await stillCurrent()) return true;
            if (outcome === 'rejected') {
                binding = { ...binding, registration: undefined };
                await put(bindingKey, binding);
                if (pending.token === token) throw new Error('Push registration rejected');
            } else {
                if (outcome === 'unknown'
                    && await api.register(session, installationId, binding.generation!, pending.operationId, pending.token) === 'rejected') {
                    throw new Error('Prior push registration outcome is unknown');
                }
                if (!await stillCurrent()) return true;
                binding = { ...binding, registration: { ...pending, done: true } };
                await put(bindingKey, binding);
                if (pending.token === token) return true;
            }
        }
        if (!await stillCurrent()) return true;
        const operationId = api.operationId();
        await put(bindingKey, { ...binding, registration: { token, operationId, done: false } });
        if (!await stillCurrent()) return true;
        if (await api.register(session, installationId, binding.generation!, operationId, token) === 'rejected') {
            rejectedRegistration = { operationId, previous: binding };
            await put(bindingKey, binding);
            rejectedRegistration = undefined;
            throw new Error('Push registration rejected');
        }
        if (await stillCurrent()) await put(bindingKey, { ...binding, registration: { token, operationId, done: true } });
        return true;
    }

    function readRequest(raw: string): { userId: string; sessionId: string; operationId: string } {
        const value = JSON.parse(raw);
        if (!value || !isUuid(value.userId) || !isUuid(value.sessionId) || !isUuid(value.operationId)) {
            throw new Error('Invalid logout request');
        }
        return value;
    }

    async function requestLogout() {
        const raw = await storage.getItem(requestKey);
        if (raw !== null) { readRequest(raw); return; }
        // A surviving journal is already scoped; keep its operation ID on retry.
        const saved = await storage.getItem(journalKey) ?? await storage.getItem(intentKey);
        const scope = saved === null ? await options.session() : readJournal(saved);
        if (!scope && saved === null) {
            if (await storage.getItem(bindingKey) !== null || await storage.getItem(bootstrapKey) !== null) {
                throw new Error('Logout session unavailable');
            }
            return; // finish still validates the existing clean marker for a true no-op.
        }
        const userId = scope && ('user' in scope ? scope.user.id : scope.userId);
        const sessionId = scope && ('access_token' in scope ? jwtSessionId(scope.access_token) : scope.sessionId);
        if (!isUuid(userId) || !isUuid(sessionId)) throw new Error('Logout session unavailable');
        const storedScope = await storage.getItem(bindingKey) ?? await storage.getItem(bootstrapKey);
        if (storedScope !== null) {
            const binding = readBinding(storedScope);
            if (binding.userId !== userId || binding.sessionId !== sessionId) {
                throw new Error('Logout session changed');
            }
        }
        await put(requestKey, { userId, sessionId,
            operationId: saved === null ? api.operationId() : (scope as Journal).operationId });
    }

    async function finish(beforeAcknowledgement: () => Promise<void>): Promise<void> {
        const [raw, anchor, storedBinding, requested] = await Promise.all([
            storage.getItem(journalKey), storage.getItem(intentKey), storage.getItem(bindingKey), storage.getItem(requestKey),
        ]);
        const request = requested === null ? undefined : readRequest(requested);
        if (raw === null && anchor === null && storedBinding === null) {
            const installation = await api.identity(false);
            const bootstrap = await storage.getItem(bootstrapKey);
            const session = await options.session();
            if (session) {
                if (request && (request.userId !== session.user.id || request.sessionId !== jwtSessionId(session.access_token))) {
                    throw new Error('Logout request session changed');
                }
                await initialize(session, async () => {
                    const current = await options.session();
                    return Boolean(current && current.user.id === session.user.id
                        && jwtSessionId(current.access_token) === jwtSessionId(session.access_token));
                });
                if (await storage.getItem(bindingKey) === null) throw new Error('Device session changed during logout');
                return finish(beforeAcknowledgement);
            }
            const clean = await storage.getItem(cleanKey);
            if (!request && !bootstrap && (!installation || clean === installation || clean === 'preflight')) return;
            throw new Error('Discovered logout has no verified local scope');
        }
        const installationId = await api.identity(false);
        if (!installationId) throw new Error('Managed device key is unavailable');
        // MVP: exact local records only. Corruption/lost scope stays blocked;
        // never discover or infer another account's cleanup target.
        let entry = raw === null ? undefined : readJournal(raw);
        const intent = anchor === null ? undefined : readJournal(anchor);
        const binding = storedBinding === null ? undefined : readBinding(storedBinding);
        if (entry && intent && (!sameScope(entry, intent) || entry.operationId !== intent.operationId
            || entry.generation !== intent.generation
            || (entry.recoveryId && intent.recoveryId && entry.recoveryId !== intent.recoveryId))) {
            throw new Error('Logout records disagree');
        }
        if (!entry) entry = intent;
        if (entry?.stage === 'begin' && intent?.recoveryId) entry = intent;
        const scope = entry ?? binding;
        if (!scope || scope.installationId !== installationId) throw new Error('Logout scope unavailable');
        if (request && (request.userId !== scope.userId || request.sessionId !== scope.sessionId
            || (entry && request.operationId !== entry.operationId))) throw new Error('Logout request session changed');
        if (binding && entry && !sameScope(binding, entry)) throw new Error('Logout binding changed');
        const current = async (scope: Scope) => {
            const session = options.recoverySession ? await options.recoverySession() : await options.session();
            if (session && !owns(session, scope)) throw new Error('Logout session changed');
            return session;
        };
        if (!entry) {
            if (!binding || !await current(binding)) throw new Error('Logout session unavailable');
            entry = { installationId, userId: scope.userId, sessionId: scope.sessionId,
                generation: binding.generation, operationId: request?.operationId ?? api.operationId(), stage: 'begin' };
            await put(intentKey, entry);
            await put(journalKey, entry);
        }
        async function checkpoint(stage: Journal['stage'], recoveryId = entry!.recoveryId) {
            const next = { ...entry!, stage, recoveryId };
            if (stage === 'revoke' && entry!.stage === 'begin') await put(intentKey, next);
            await put(journalKey, next);
            entry = next;
        }
        if (entry.stage === 'begin') {
            const session = await current(entry);
            if (!session) throw new Error('Logout session unavailable');
            if (!entry.generation) await api.ensureInstallation(session, installationId);
            if (!await current(entry)) throw new Error('Logout session unavailable');
            await checkpoint('revoke', await api.begin(session, entry));
        }
        if (entry.stage === 'revoke') {
            const session = await current(entry);
            if (!session) throw new Error('Logout session unavailable');
            // Only a definitive Auth success advances the durable checkpoint.
            // Unknown responses remain retryable while the same session exists.
            await options.revoke(session);
            await checkpoint('clear');
        }
        if (entry.stage === 'confirm') throw new Error('Legacy logout checkpoint requires manual recovery');
        if (entry.stage === 'clear') {
            await current(entry);
            await options.clean(entry);
            await beforeAcknowledgement();
            await checkpoint('ack');
        }
        await current(entry);
        const receipt = await api.recovery(installationId, 'ack', entry.recoveryId!);
        if (receipt.status !== 'cleared') throw new Error('Logout cleanup not acknowledged');
        await storage.setItem(cleanKey, installationId);
        await storage.removeItem(bindingKey);
        await storage.removeItem(intentKey);
        await storage.removeItem(requestKey);
        await storage.removeItem(journalKey);
    }

    return { save, finish, requestLogout, availability, initialize, prepareAuthentication, notificationReady };
}
