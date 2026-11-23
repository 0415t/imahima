export type LogoutSession = { user: { id: string }; access_token: string };

type Storage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

type Registration = { tokens: string[]; pending: boolean };
type PendingLogout = { userId?: string; revoked?: boolean };

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
}) {
    const pendingKey = deps.prefix + ':logout';
    const cutoffKey = deps.prefix + ':notification-cutoff';
    const listeners = new Set<() => void>();
    let blocked = false;
    let revision = 0;
    let logout: Promise<{ error: Error | null }> | undefined;
    let registration: Promise<void> | undefined;
    let authenticating = false;

    const key = (userId: string) => deps.prefix + ':push:' + userId;
    const read = async (userId: string): Promise<Registration | null> => {
        const raw = await deps.storage.getItem(key(userId));
        if (raw === null) return null;
        const value: Registration = JSON.parse(raw);
        if (!Array.isArray(value.tokens) || !value.tokens.every(token => typeof token === 'string' && token)
            || typeof value.pending !== 'boolean') throw new Error('Invalid device registration record');
        return value;
    };
    const write = (userId: string, value: Registration) =>
        deps.storage.setItem(key(userId), JSON.stringify(value));

    async function removalTargets(session: LogoutSession): Promise<string[]> {
        const userId = session.user.id;
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

    async function canUseSession() {
        if (blocked) return false;
        const started = revision;
        try {
            return await deps.storage.getItem(pendingKey) === null && !blocked && started === revision;
        } catch {
            return false;
        }
    }

    async function canUseNotification(receivedAt: number | undefined) {
        try {
            const raw = await deps.storage.getItem(cutoffKey);
            return (raw === null || (receivedAt !== undefined && receivedAt > Number(raw)))
                && await canUseSession();
        } catch {
            return false;
        }
    }

    async function authenticate<T>(operation: () => PromiseLike<T>): Promise<T> {
        if (authenticating) throw new Error('認証処理を実行中です');
        authenticating = true;
        try {
            if (!await canUseSession()) throw new Error('ログアウト処理が完了していません');
            return await operation();
        } finally {
            authenticating = false;
        }
    }

    function save(userId: string, token: string): Promise<void> {
        if (registration) return registration.then(() => save(userId, token));
        const operation = Promise.resolve().then(async () => {
            if (!await canUseSession()) return;
            const session = await deps.session();
            if (session?.user.id !== userId || !await canUseSession()) return;
            const previous = await read(userId);
            if (previous?.pending) return;
            if (!await canUseSession()) return;
            const tokens = [...new Set([...(previous?.tokens ?? []), token])];
            // Persist before sending. A lost response may still commit after a later DELETE.
            await write(userId, { tokens, pending: true });
            const { rejected } = await deps.register(session, token);
            if (rejected) {
                if (previous) await write(userId, previous);
                else await deps.storage.removeItem(key(userId));
                throw rejected;
            }
            await write(userId, { tokens, pending: false });
        }).finally(() => { registration = undefined; });
        registration = operation;
        return operation;
    }

    function signOut() {
        if (logout) return logout;
        if (authenticating) return Promise.resolve({ error: new Error('認証処理を実行中です') });
        logout = Promise.resolve().then(async () => {
            const raw = await deps.storage.getItem(pendingKey);
            const pending: PendingLogout = raw === null ? {} : JSON.parse(raw);
            if (raw === null) await deps.storage.setItem(pendingKey, JSON.stringify(pending));
            await registration?.catch(() => {});
            const session = await deps.session();
            if (pending.userId && session && pending.userId !== session.user.id) {
                throw new Error('Logout session changed');
            }
            if (session) {
                const userId = session.user.id;
                if (!pending.revoked) {
                    await deps.storage.setItem(pendingKey, JSON.stringify({ userId }));
                    for (const token of await removalTargets(session)) {
                        await deps.remove(session, token);
                    }
                    await deps.storage.setItem(cutoffKey, String(Date.now()));
                    const current = await deps.session();
                    if (current?.user.id !== userId) throw new Error('Logout session changed');
                    // Auth JS can discard the local session even when remote logout fails.
                    await deps.revoke(current);
                    await deps.storage.setItem(pendingKey, JSON.stringify({ userId, revoked: true }));
                }
                const current = await deps.session();
                if (current && current.user.id !== userId) throw new Error('Logout session changed');
                if (current) await deps.signOut();
                await deps.storage.removeItem(key(userId));
            } else if (pending.revoked && pending.userId) {
                await deps.storage.removeItem(key(pending.userId));
            } else if (raw !== null) {
                throw new Error('Logout session is unavailable before revocation was confirmed');
            }
            await deps.storage.removeItem(pendingKey);
            setBlocked(false);
            return { error: null };
        }).catch((error: unknown) => ({
            error: error instanceof Error ? error : new Error(String(error)),
        })).finally(() => { logout = undefined; });
        setBlocked(true);
        return logout;
    }

    return {
        save, signOut, authenticate, canUseSession, canUseNotification,
        revision: () => revision,
        isBlocked: () => blocked,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
