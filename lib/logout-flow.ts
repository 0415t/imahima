import { jwtSessionId } from './session-identity';
import type { createManagedLogout } from './managed-logout';

export type LogoutSession = { user: { id: string }; access_token: string };

type Storage = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};

export function createLogoutFlow(deps: {
    storage: Storage;
    prefix: string;
    session(): Promise<LogoutSession | null>;
    managed: ReturnType<typeof createManagedLogout>;
}) {
    const cutoffKey = deps.prefix + ':notification-cutoff';
    const listeners = new Set<() => void>();
    let blocked = false;
    let logoutError: Error | null = null;
    let revision = 0;
    let logout: Promise<{ error: Error | null }> | undefined;
    let registration: Promise<void> | undefined;
    let authenticating = false;
    let provisioning: Promise<void> | undefined;

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
            const managed = await deps.managed.availability();
            if (blocked || started !== revision) return 'read-failed';
            return managed;
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
            if (authenticating || !await canUseSession() || !await deps.managed.notificationReady()) return false;
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
        for (const listener of listeners) listener();
        try {
            if (!await canUseSession()) throw new Error('ログアウト処理が完了していません');
            const cutoff = await deps.storage.getItem(cutoffKey);
            // Cover notifications delivered while durable logout cleanup was finishing.
            if (cutoff !== null) await advanceCutoff(cutoff);
            if (!await canUseSession()) throw new Error('ログアウト処理が完了していません');
            if (await deps.session()) throw new Error('Sign out before starting another session');
            await deps.managed.prepareAuthentication();
            try {
                const result = await operation();
                await prepareSession();
                return result;
            }
            finally { if (cutoff !== null) await advanceCutoff(); }
        } finally {
            authenticating = false;
            revision++;
            for (const listener of listeners) listener();
        }
    }

    function prepareSession(): Promise<void> {
        if (provisioning) return provisioning;
        provisioning = (async () => {
            const session = await deps.session();
            if (!session) return;
            await deps.managed.initialize(session, () => stillCurrent(session));
        })().finally(() => { provisioning = undefined; });
        return provisioning;
    }

    async function stillCurrent(session: LogoutSession) {
        if (!await canUseSession()) return false;
        const current = await deps.session();
        return current?.user.id === session.user.id && jwtSessionId(current.access_token) === jwtSessionId(session.access_token)
            && await canUseSession();
    }

    function save(userId: string, token: string): Promise<void> {
        if (registration) {
            const next = () => save(userId, token);
            return registration.then(next, next);
        }
        registration = (async () => {
            if (authenticating || !await canUseSession()) return;
            const session = await deps.session();
            if (session?.user.id !== userId || !await stillCurrent(session)) return;
            await prepareSession();
            if (!await stillCurrent(session)) return;
            await deps.managed.save(session, token, () => stillCurrent(session));
        })().finally(() => { registration = undefined; });
        return registration;
    }

    function signOut() {
        if (logout) return logout;
        if (authenticating) return Promise.resolve({ error: new Error('認証処理を実行中です') });
        logout = Promise.resolve().then(async () => {
            await registration?.catch(() => {});
            await provisioning?.catch(() => {});
            await deps.managed.finish(advanceCutoff);
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
        save, signOut, authenticate, prepareSession, canUseSession, sessionAvailability, canUseNotification,
        revision: () => revision,
        isBlocked: () => blocked,
        isAuthenticating: () => authenticating,
        getError: () => logoutError,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
