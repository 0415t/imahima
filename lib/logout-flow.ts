import { jwtSessionId } from './session-identity';
import type { createManagedLogout } from './managed-logout';

export type LogoutSession = { user: { id: string }; access_token: string };

type Storage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

type Registration = { tokens: string[]; pending: boolean };
type PendingLogout = { userId: string; sessionId: string; revoked?: boolean };

function parsePendingLogout(raw: string): PendingLogout {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'userId' in value && 'sessionId' in value
        && typeof value.userId === 'string' && value.userId.trim()
        && typeof value.sessionId === 'string' && value.sessionId.trim()) {
        const revoked = 'revoked' in value ? value.revoked : undefined;
        if (revoked === undefined || typeof revoked === 'boolean') {
            return { userId: value.userId, sessionId: value.sessionId, revoked };
        }
    }
    throw new Error('Invalid logout record');
}

export function createLogoutFlow(deps: {
    storage: Storage;
    prefix: string;
    session(): Promise<LogoutSession | null>;
    resolveToken(): Promise<string | null>;
    hasRegistrations(session: LogoutSession): Promise<boolean>;
    register(session: LogoutSession, token: string): Promise<{ rejected: Error | null }>;
    remove(session: LogoutSession, token: string): Promise<void>;
    revoke(session: LogoutSession): Promise<void>;
    signOut(): Promise<void>;
    managed?: ReturnType<typeof createManagedLogout>;
}) {
    const pendingKey = deps.prefix + ':logout';
    const cutoffKey = deps.prefix + ':notification-cutoff';
    const listeners = new Set<() => void>();
    let blocked = false;
    let logoutError: Error | null = null;
    let revision = 0;
    let logout: Promise<{ error: Error | null }> | undefined;
    let registration: Promise<void> | undefined;
    let authenticating = false;
    const confirmedRegistrations = new Map<string, Registration | null>();
    let confirmedRevocation: PendingLogout | undefined;

    const key = (userId: string) => deps.prefix + ':push:' + userId;
    const read = async (userId: string): Promise<Registration | null> => {
        const raw = await deps.storage.getItem(key(userId));
        if (raw === null) return null;
        const value: Registration = JSON.parse(raw);
        if (!value || !Array.isArray(value.tokens) || !value.tokens.every(token => typeof token === 'string' && token)
            || typeof value.pending !== 'boolean') throw new Error('Invalid device registration record');
        return value;
    };
    const write = (userId: string, value: Registration) =>
        deps.storage.setItem(key(userId), JSON.stringify(value));

    async function repairRegistration(userId: string) {
        const outcome = confirmedRegistrations.get(userId);
        if (outcome === undefined) return;
        if (outcome === null) await deps.storage.removeItem(key(userId));
        else await write(userId, outcome);
        confirmedRegistrations.delete(userId);
    }

    async function removalTargets(session: LogoutSession): Promise<string[]> {
        const userId = session.user.id;
        await repairRegistration(userId);
        const record = await read(userId);
        if (record?.pending) throw new Error('Push registration outcome is unknown');
        if (record) return record.tokens;

        const token = await deps.resolveToken().catch(async () => {
            if (await deps.hasRegistrations(session)) throw new Error('Current push token could not be resolved');
            return null;
        });
        const tokens = token === null ? [] : [token];
        await write(userId, { tokens, pending: false });
        return tokens;
    }

    function setBlocked(value: boolean) {
        if (blocked === value) return;
        blocked = value;
        revision++;
        for (const listener of listeners) listener();
    }

    async function sessionAvailability(): Promise<'ready' | 'logout-pending' | 'read-failed'> {
        if (blocked) return 'logout-pending';
        const started = revision;
        try {
            const marker = await deps.storage.getItem(pendingKey);
            const managed = await deps.managed?.availability();
            if (blocked || started !== revision) return 'read-failed';
            return marker === null && managed !== 'logout-pending' ? 'ready' : 'logout-pending';
        } catch {
            return 'read-failed';
        }
    }

    async function canUseSession() {
        return await sessionAvailability() === 'ready';
    }

    async function canUseNotification(receivedAt: number | undefined) {
        try {
            const started = revision;
            if (authenticating || !await canUseSession()) return false;
            const raw = await deps.storage.getItem(cutoffKey);
            return (raw === null || (receivedAt !== undefined && receivedAt > Number(raw)))
                && await canUseSession() && !authenticating && started === revision;
        } catch {
            return false;
        }
    }

    async function advanceCutoff(previous?: string | null) {
        const raw = previous === undefined ? await deps.storage.getItem(cutoffKey) : previous;
        const time = Math.max(Date.now(), Number(raw) || 0);
        await deps.storage.setItem(cutoffKey, String(time));
    }

    async function authenticate<T>(operation: () => PromiseLike<T>): Promise<T> {
        if (authenticating) throw new Error('認証処理を実行中です');
        authenticating = true;
        revision++;
        try {
            if (!await canUseSession()) throw new Error('ログアウト処理が完了していません');
            const cutoff = await deps.storage.getItem(cutoffKey);
            // Cover notifications delivered while durable logout cleanup was finishing.
            if (cutoff !== null) await advanceCutoff(cutoff);
            if (!await canUseSession()) throw new Error('ログアウト処理が完了していません');
            try { return await operation(); }
            finally { if (cutoff !== null) await advanceCutoff(); }
        } finally {
            authenticating = false;
        }
    }

    function save(userId: string, token: string): Promise<void> {
        if (registration) {
            const next = () => save(userId, token);
            return registration.then(next, next);
        }
        const operation = Promise.resolve().then(async () => {
            if (!await canUseSession()) return;
            const session = await deps.session();
            if (session?.user.id !== userId || !await canUseSession()) return;
            await repairRegistration(userId);
            const previous = await read(userId);
            if (deps.managed && await deps.managed.save(session, token, async () =>
                previous === null && !await deps.hasRegistrations(session), async () => {
                    if (!await canUseSession()) return false;
                    const current = await deps.session();
                    return current?.user.id === userId && jwtSessionId(current.access_token) === jwtSessionId(session.access_token)
                        && await canUseSession();
                })) return;
            if (previous?.pending) return;
            if (!await canUseSession()) return;
            const tokens = [...new Set([...(previous?.tokens ?? []), token])];
            // Persist before sending. A lost response may still commit after a later DELETE.
            await write(userId, { tokens, pending: true });
            const { rejected } = await deps.register(session, token);
            confirmedRegistrations.set(userId, rejected ? previous : { tokens, pending: false });
            await repairRegistration(userId);
            if (rejected) throw rejected;
        }).finally(() => { registration = undefined; });
        registration = operation;
        return operation;
    }

    function signOut() {
        if (logout) return logout;
        if (authenticating) return Promise.resolve({ error: new Error('認証処理を実行中です') });
        logout = Promise.resolve().then(async () => {
            const raw = await deps.storage.getItem(pendingKey);
            if (deps.managed) {
                await registration?.catch(() => {});
                if (await deps.managed.finish(raw !== null, advanceCutoff)) return;
            }
            const pending = raw === null ? undefined : parsePendingLogout(raw);
            if (pending && confirmedRevocation && (pending.userId !== confirmedRevocation.userId
                || pending.sessionId !== confirmedRevocation.sessionId)) throw new Error('Logout session changed');
            const checkpoint = confirmedRevocation ?? pending;
            const session = await deps.session();
            if (!session && !checkpoint) return;
            if (!session && checkpoint?.revoked !== true) throw new Error('Logout session is unavailable before revocation was confirmed');

            const userId = checkpoint?.userId ?? session?.user.id;
            const sessionId = checkpoint?.sessionId ?? (session && jwtSessionId(session.access_token));
            if (!userId || !sessionId) throw new Error('Logout session identity is unavailable');
            const matches = (current: LogoutSession) => current.user.id === userId
                && jwtSessionId(current.access_token) === sessionId;
            if (session && !matches(session)) throw new Error('Logout session changed');

            if (session && checkpoint?.revoked !== true) {
                await deps.storage.setItem(pendingKey, JSON.stringify({ userId, sessionId }));
                await registration?.catch(() => {});
                for (const token of await removalTargets(session)) {
                    await deps.remove(session, token);
                }
                const current = await deps.session();
                if (!current || !matches(current)) throw new Error('Logout session changed');
                // Auth JS can discard the local session even when remote logout fails.
                await deps.revoke(current);
                confirmedRevocation = { userId, sessionId, revoked: true };
            }
            if (confirmedRevocation) {
                await deps.storage.setItem(pendingKey, JSON.stringify(confirmedRevocation));
                confirmedRevocation = undefined;
            }
            if ((await read(userId))?.pending) throw new Error('Push registration outcome is unknown');
            const current = await deps.session();
            if (current && !matches(current)) throw new Error('Logout session changed');
            if (current) await deps.signOut();
            await deps.storage.removeItem(key(userId));
            await advanceCutoff();
            await deps.storage.removeItem(pendingKey);
        }).then(() => {
            setBlocked(false);
            return { error: null };
        }).catch((error: unknown) => {
            logoutError = error instanceof Error ? error : new Error(String(error));
            for (const listener of listeners) listener();
            return { error: logoutError };
        }).finally(() => { logout = undefined; });
        const retrying = blocked;
        logoutError = null;
        setBlocked(true);
        if (retrying) for (const listener of listeners) listener();
        return logout;
    }

    return {
        save, signOut, authenticate, canUseSession, sessionAvailability, canUseNotification,
        revision: () => revision,
        isBlocked: () => blocked,
        getError: () => logoutError,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
