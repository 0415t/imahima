import { uuid } from 'expo-modules-core';
import { Platform } from 'react-native';
import type { DeviceProofRequest, LogoutRecoveryProofRequest } from '../modules/device-key';
import type { LogoutSession } from './logout-flow';
import type { ManagedDeviceApi } from './managed-logout';
import { jwtSessionId } from './session-identity';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// Expo's native UUID v4 uses the OS RNG. Remove the fixed version/variant
// nibbles before using 64 random hex digits as a 32-byte challenge nonce.
function randomNonce() {
    let hex = '';
    for (let i = 0; i < 3; i++) {
        const candidate = uuid.v4();
        if (candidate.length !== 36 || !uuidPattern.test(candidate) || candidate[14] !== '4'
            || !'89ab'.includes(candidate[19])) throw new Error('Secure random data unavailable');
        const value = candidate.replaceAll('-', '');
        hex += value.slice(0, 12) + value.slice(13, 16) + value.slice(17);
    }
    let output = '', buffer = 0, bits = 0;
    for (let i = 0; i < 64; i += 2) {
        buffer = (buffer << 8) | parseInt(hex.slice(i, i + 2), 16);
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            output += alphabet[(buffer >> bits) & 63];
        }
    }
    if (bits) output += alphabet[(buffer << (6 - bits)) & 63];
    return output;
}

export function createDeviceRecoveryApi(apiUrl: string | undefined, supabaseUrl: string | undefined): ManagedDeviceApi {
    const issuer = () => new URL('/auth/v1', supabaseUrl).href;
    let enrolled: string | undefined;
    function endpoint(hasBearer: boolean) {
        const base = new URL(apiUrl ?? '');
        const localDevelopmentHttp = base.protocol === 'http:' && !hasBearer && __DEV__
            && ['localhost', '127.0.0.1', '10.0.2.2'].includes(base.hostname);
        if (base.protocol !== 'https:' && !localDevelopmentHttp) {
            throw new Error('Secure device recovery API required');
        }
        return base;
    }
    async function post(action: string, body: Record<string, unknown>, accessToken?: string) {
        const base = endpoint(Boolean(accessToken));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        try {
            const response = await fetch(new URL('/device-recovery/' + action, base).href, {
                method: 'POST', headers: { 'content-type': 'application/json',
                    ...(accessToken ? { authorization: 'Bearer ' + accessToken } : {}) },
                body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
            });
            if (action === 'register' && (response.status === 403 || response.status === 409)
                && (await response.json())?.registrationOutcome === 'rejected') return { rejected: true };
            if (response.status !== 200) throw new Error('Device recovery request failed');
            return await response.json();
        } finally { clearTimeout(timer); }
    }

    async function signDevice(request: DeviceProofRequest) {
        const result = await (await import('../modules/device-key')).signDeviceProof(request);
        if (result.status !== 'ready') throw new Error('Device signing unavailable');
        return result.signature;
    }

    async function operation(session: LogoutSession, installationId: string,
        action: 'enroll' | 'register' | 'begin_logout' | 'lookup' | 'lookup_generation' | 'begin_session_logout',
        data?: { generation?: string; operationId: string; token?: string }) {
        const sessionId = jwtSessionId(session.access_token);
        if (!sessionId) throw new Error('Device session identity unavailable');
        const context = { issuer: issuer(), keyVersion: '1', userId: session.user.id, sessionId };
        const clientNonce = randomNonce();
        const issued = await post('challenge', { installationId, keyVersion: '1', purpose: action, nonce: clientNonce,
            signature: await signDevice({ ...context, action: 'challenge', purpose: action, nonce: clientNonce }) }, session.access_token);
        const nonce = checkedNonce(issued?.nonce);
        if (action === 'enroll' || action === 'lookup_generation') {
            return (await post(action.replaceAll('_', '-'), { installationId, keyVersion: '1', nonce,
                signature: await signDevice({ ...context, action, nonce }) }, session.access_token)).result;
        }
        if (!data) throw new Error('Device operation scope unavailable');
        if (action === 'begin_session_logout') {
            const proof = { ...context, action, nonce, operationId: data.operationId } as const;
            return (await post('begin-session-logout', { installationId, keyVersion: '1', nonce, operationId: data.operationId,
                signature: await signDevice(proof) }, session.access_token)).result;
        }
        if (!data.generation) throw new Error('Generation unavailable');
        const platform = Platform.OS;
        if (action === 'register' && (typeof data.token !== 'string' || (platform !== 'ios' && platform !== 'android'))) {
            throw new Error('Push platform unavailable');
        }
        const scope = { generation: data.generation, operationId: data.operationId };
        const push = action === 'register' ? { token: data.token!, platform: platform as 'ios' | 'android' } : undefined;
        const signature = await signDevice(push
            ? { ...context, ...scope, ...push, action: 'register', nonce }
            : { ...context, ...scope, action: action === 'lookup' ? 'lookup' : 'begin_logout', nonce });
        const response = await post(action === 'begin_logout' ? 'begin-logout' : action, {
            installationId, keyVersion: '1', ...scope, ...push, nonce, signature,
        }, session.access_token);
        return action === 'register' && response?.rejected === true ? 'rejected' : response?.result;
    }

    return {
        validateConfiguration() { endpoint(true); issuer(); },
        async identity(create) {
            if (!apiUrl || !supabaseUrl) throw new Error('Device recovery API is not configured');
            if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
            const native = await import('../modules/device-key');
            if (!native.supportsLogoutRecoverySigning()) return null;
            let result = await native.getIdentity();
            if (create && (result.status === 'uninitialized' || result.status === 'initializing')) result = await native.createInstallation();
            if (result.status === 'unsupported' || (!create && (result.status === 'uninitialized' || result.status === 'initializing'))) return null;
            if (result.status !== 'ready') throw new Error('Managed device key unavailable');
            return result.installationId;
        },
        operationId: () => uuid.v4(),
        async ensureInstallation(session, installationId) {
            if (enrolled !== installationId) {
                const native = await import('../modules/device-key');
                const identity = await native.getIdentity();
                const sessionId = jwtSessionId(session.access_token);
                if (!sessionId || identity.status !== 'ready' || identity.installationId !== installationId) throw new Error('Device identity changed');
                const issued = await post('enrollment-challenge', { installationId, publicKey: identity.publicKey }, session.access_token);
                const nonce = checkedNonce(issued?.nonce);
                const signature = await signDevice({ issuer: issuer(), action: 'enroll-installation', nonce, userId: session.user.id, sessionId });
                const result = await post('enroll-installation', { installationId, publicKey: identity.publicKey, nonce, signature }, session.access_token);
                if (result?.keyVersion !== '1') throw new Error('Invalid device key version');
                enrolled = installationId;
            }
        },
        async open(session, installationId) {
            return checkedGeneration(await operation(session, installationId, 'enroll'));
        },
        async lookupGeneration(session, installationId) {
            const generation = await operation(session, installationId, 'lookup_generation');
            return generation === null ? null : checkedGeneration(generation);
        },
        async register(session, installationId, generation, operationId, token) {
            const result = await operation(session, installationId, 'register', { generation, operationId, token });
            if (result === 'rejected') return 'rejected';
            if (result?.registered !== true || result?.generation !== generation) throw new Error('Push registration not confirmed');
        },
        async lookupRegistration(session, installationId, generation, operationId) {
            const result = await operation(session, installationId, 'lookup', { generation, operationId });
            if (result === null) return 'unknown';
            if (result?.generation === generation) {
                if (result.registered === true) return 'registered';
                if (result.registered === false && result.reason === 'device_token_unavailable') return 'rejected';
            }
            throw new Error('Invalid push registration lookup result');
        },
        async begin(session, intent) {
            const result = await operation(session, intent.installationId,
                intent.generation ? 'begin_logout' : 'begin_session_logout', intent);
            return checkedId(result?.recoveryId);
        },
        async recovery(installationId, action, recoveryId, binding) {
            const native = await import('../modules/device-key');
            const context = { issuer: issuer(), keyVersion: '1' };
            const issue = { ...context, action: 'challenge' as const, nonce: randomNonce(), issuedAt: String(Math.floor(Date.now() / 1_000)) };
            const scope = binding ? { bindingUserId: binding.userId, bindingSessionId: binding.sessionId,
                ...(binding.generation ? { bindingGeneration: binding.generation }
                    : { bindingOperationId: checkedId(binding.operationId) }) } : null;
            if (action === 'discover-binding' && !scope) throw new Error('Recovery scope unavailable');
            const proof: LogoutRecoveryProofRequest = action === 'discover-binding'
                ? { ...issue, purpose: action, ...scope! } : action === 'discover'
                    ? { ...issue, purpose: action } : { ...issue, purpose: action, recoveryId: checkedId(recoveryId) };
            const sign = async (input: LogoutRecoveryProofRequest) => {
                const result = await native.signLogoutRecoveryProof(input);
                if (result.status !== 'ready') throw new Error('Recovery signing unavailable');
                return result.signature;
            };
            const target = action === 'discover-binding' ? scope : action === 'discover' ? {} : { recoveryId };
            const issued = await post('recovery/challenge', { installationId, keyVersion: '1', ...target,
                purpose: action, issuedAt: issue.issuedAt, nonce: issue.nonce, signature: await sign(proof) });
            const nonce = checkedNonce(issued?.nonce);
            const use: LogoutRecoveryProofRequest = action === 'discover-binding'
                ? { ...context, action, nonce, ...scope! } : action === 'discover'
                    ? { ...context, action, nonce } : { ...context, action, nonce, recoveryId: checkedId(recoveryId) };
            const { result } = await post('recovery/' + action, { installationId, keyVersion: '1', ...target, nonce, signature: await sign(use) });
            const resolved = checkedId(result?.recoveryId);
            if (((action === 'confirm' || action === 'ack') && resolved !== recoveryId)
                || !['pending', 'confirmed', 'cleared'].includes(result?.status)) {
                throw new Error('Invalid recovery receipt');
            }
            return { recoveryId: resolved, status: result.status };
        },
    };
}

function checkedGeneration(value: unknown) {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('Invalid generation reply');
    return value;
}

function checkedNonce(value: unknown) {
    if (typeof value !== 'string' || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid challenge');
    return value;
}

function checkedId(value: unknown) {
    if (typeof value !== 'string' || value.length !== 36 || !uuidPattern.test(value)) throw new Error('Invalid recovery ID');
    return value;
}
