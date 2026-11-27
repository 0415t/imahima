import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { authenticationErrorStatus } from './auth';
import { abortable, TIMEOUTS } from './timeouts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const publicKeyPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const purposes = ['enroll', 'register', 'fence', 'lookup', 'confirm_auth_revocation', 'begin_logout',
  'lookup_generation', 'begin_session_logout'];
const hash = (value: Buffer) => createHash('sha256').update(value).digest();

class Rejected extends Error {
  constructor(readonly status: number) { super('Device verification rejected'); }
}

function string(value: unknown, pattern: RegExp, max: number): string {
  if (typeof value !== 'string' || value.length > max || pattern.exec(value)?.[0] !== value) throw new Rejected(400);
  return value;
}

function positiveBigint(value: unknown): string {
  const decimal = string(value, /^[1-9][0-9]*$/, 19);
  if (BigInt(decimal) > 9223372036854775807n) throw new Rejected(400);
  return decimal;
}

function encodedBytes(value: unknown, size: number): Buffer {
  const encoded = string(value, /^[A-Za-z0-9_-]+$/, Math.ceil(size * 4 / 3));
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== encoded) throw new Rejected(400);
  return bytes;
}

function p256Key(bytes: Buffer) {
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Rejected(400);
  try {
    return createPublicKey({ key: Buffer.concat([publicKeyPrefix, bytes]), type: 'spki', format: 'der' });
  } catch {
    throw new Rejected(400);
  }
}

function signingBytes(domain: string, fields: readonly (string | null)[]): Buffer {
  return Buffer.concat([domain, ...fields].map(field =>
    field === null ? Buffer.from('-:') : Buffer.from(`${Buffer.byteLength(field)}:${field}`)));
}

export function deviceSigningBytes(fields: readonly (string | null)[]): Buffer {
  return signingBytes('imahima-device-proof-v1', fields);
}

export function logoutRecoverySigningBytes(fields: readonly (string | null)[]): Buffer {
  return signingBytes('imahima-logout-recovery-v1', fields);
}

type ClaimsLookup = (token: string) => Promise<{ data: { claims: unknown } | null; error: unknown }>;

async function getIdentity(header: string | undefined, issuer: string, claimsLookup: ClaimsLookup) {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i);
  if (!match || match[1].length > 8192) throw new Rejected(401);
  let result;
  try {
    result = await abortable(() => claimsLookup(match[1]), AbortSignal.timeout(TIMEOUTS.auth));
  } catch (error) {
    throw new Rejected(authenticationErrorStatus(error));
  }
  if (result.error) throw new Rejected(authenticationErrorStatus(result.error));
  const claims = result.data?.claims as Record<string, unknown> | undefined;
  if (!claims || claims.iss !== issuer || claims.aud !== 'authenticated' || claims.role !== 'authenticated' ||
      typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= Date.now() / 1000 ||
      typeof claims.sub !== 'string' || !uuidPattern.test(claims.sub) ||
      typeof claims.session_id !== 'string' || !uuidPattern.test(claims.session_id)) throw new Rejected(401);
  return { user: claims.sub, session: claims.session_id };
}

export function createDeviceVerifierPool(connectionString: string) {
  const pool = new Pool({
    connectionString, max: 4, connectionTimeoutMillis: 2000, idleTimeoutMillis: 10000, query_timeout: 7000,
  });
  pool.on('error', () => { /* The pool has already discarded the failed idle connection. */ });
  return pool;
}

async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>, recovery = false): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  let committing = false;
  const connectionLost = () => { discard = true; };
  db.on('error', connectionLost);
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL search_path = pg_catalog;
      SET LOCAL lock_timeout = '1500ms';
      SET LOCAL statement_timeout = '3000ms';
      SET LOCAL idle_in_transaction_session_timeout = '5s';
      SET LOCAL transaction_timeout = '6s'`);
    const login = recovery ? 'imahima_logout_recovery_api_login' : 'imahima_device_api_login';
    const verifier = recovery ? 'imahima_logout_recovery_verifier' : 'imahima_device_verifier';
    const role = await db.query(`SELECT session_user::text = $1
      AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid
          AND (m.roleid <> $2::regrole OR m.admin_option OR m.inherit_option)
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = $2::regrole
      ) AND EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles v WHERE v.oid = $2::regrole AND
          NOT (v.rolcanlogin OR v.rolsuper OR v.rolcreaterole OR v.rolcreatedb OR v.rolreplication OR v.rolbypassrls)
      ) AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`, [login, verifier]);
    if (role.rows[0]?.allowed !== true) throw new Rejected(503);
    await db.query(recovery ? 'SET LOCAL ROLE imahima_logout_recovery_verifier' : 'SET LOCAL ROLE imahima_device_verifier');
    const result = await run(db);
    committing = true;
    if ((await db.query('COMMIT')).command !== 'COMMIT') throw new Rejected(503);
    return result;
  } catch (error) {
    if (committing) discard = true;
    if (!discard) {
      try { await db.query('ROLLBACK'); } catch { discard = true; }
    }
    throw error;
  } finally {
    db.off('error', connectionLost);
    db.release(discard);
  }
}

class RegistrationRejected extends Rejected {}

const operations = {
  enroll: 'SELECT push_private.open_device_generation($1,$2,$3,$4,$5) AS result',
  register: 'SELECT push_private.register_device_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
  fence: 'SELECT push_private.fence_device_registration($1,$2,$3,$4,$5,$6,$7) AS result',
  begin_logout: 'SELECT push_private.begin_device_logout($1,$2,$3,$4,$5,$6,$7) AS result',
  lookup_generation: 'SELECT push_private.lookup_device_generation($1,$2,$3,$4,$5) AS result',
  begin_session_logout: 'SELECT push_private.begin_device_session_logout($1,$2,$3,$4,$5,$6) AS result',
  lookup: 'SELECT push_private.get_device_operation($1,$2,$3,$4,$5,$6,$7) AS result',
  confirm_auth_revocation: 'SELECT push_private.confirm_auth_revocation($1,$2,$3,$4,$5,$6) AS result',
} as const;

async function requireLiveSession(db: PoolClient, identity: { user: string; session: string }) {
  const checked = await db.query('SELECT push_private.auth_session_present($1,$2) AS present',
    [identity.user, identity.session]).catch(() => { throw new Rejected(503); });
  const present = checked.rows[0]?.present;
  if (present !== true) throw new Rejected(present === false ? 401 : 503);
}

export function notificationSessionAuthenticator(pool: Pool, issuer: string, claimsLookup: ClaimsLookup) {
  return async (token: string) => {
    try {
      const identity = await getIdentity(`Bearer ${token}`, issuer, claimsLookup);
      await transaction(pool, db => requireLiveSession(db, identity));
      return { userId: identity.user, sessionId: identity.session, status: 200 as const };
    } catch (error) {
      return { userId: null, status: error instanceof Rejected && error.status === 401 ? 401 as const : 503 as const };
    }
  };
}

export function notificationSessionExtender(pool?: Pool) {
  return async (userId: string, claimId: string, sessionId?: string) => {
    const unavailable = { isFree: null, freeUntil: null, error: null };
    if (!pool || !sessionId) return { ...unavailable, status: 503 as const };
    try {
      const row = await transaction(pool, async db => (await db.query(
        'SELECT * FROM push_private.extend_free_for_live_notification_session($1,$2,$3)',
        [userId, sessionId, claimId])).rows[0]);
      return { isFree: row?.is_free ?? null, freeUntil: row?.free_until ?? null, error: null };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '28000') return { ...unavailable, status: 401 as const };
      if (code === 'P0001') return { ...unavailable, error };
      return { ...unavailable, status: 503 as const };
    }
  };
}

const signedFields = ['installationId', 'keyVersion', 'nonce', 'signature'];
const operationFields = [...signedFields, 'generation', 'operationId'];
const requestFields = {
  'enrollment-challenge': ['installationId', 'publicKey'],
  'enroll-installation': ['installationId', 'publicKey', 'nonce', 'signature'],
  challenge: [...signedFields, 'purpose'],
  enroll: signedFields,
  register: [...operationFields, 'token', 'platform', 'deviceName'],
  fence: operationFields,
  begin_logout: operationFields,
  lookup_generation: signedFields,
  begin_session_logout: [...signedFields, 'operationId'],
  lookup: operationFields,
  confirm_auth_revocation: operationFields,
};

export function deviceVerifierRouter(pool: Pool, issuer: string, claimsLookup: ClaimsLookup, recoveryEnabled = false) {
  const router = express.Router();
  router.use(express.json({ limit: '4kb', inflate: false }));
  router.post('/:action', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const path = request.params.action;
      const action = (path === 'confirm-auth-revocation' ? 'confirm_auth_revocation' :
        path === 'begin-logout' ? 'begin_logout' : path === 'lookup-generation' ? 'lookup_generation' :
        path === 'begin-session-logout' ? 'begin_session_logout' : path) as keyof typeof requestFields;
      if (['confirm_auth_revocation', 'begin_logout', 'lookup_generation', 'begin_session_logout'].includes(path)) throw new Rejected(404);
      if (!Object.hasOwn(requestFields, action)) throw new Rejected(404);
      if (!request.is('application/json') || !request.body || Array.isArray(request.body)) throw new Rejected(400);
      const body = request.body;
      if (Object.keys(body).some(field => !requestFields[action].includes(field))) throw new Rejected(400);
      const installation = string(body.installationId, uuidPattern, 36);
      const bootstrap = action === 'enrollment-challenge' || action === 'enroll-installation';
      const publicKey = bootstrap ? encodedBytes(body.publicKey, 65) : null;
      const keyVersion = bootstrap ? '1' : positiveBigint(body.keyVersion);
      const purpose = action === 'challenge' ? body.purpose : action;
      if (action === 'challenge' && !purposes.includes(purpose)) throw new Rejected(400);
      if (['begin_logout', 'lookup_generation', 'begin_session_logout'].includes(purpose) && !recoveryEnabled) throw new Rejected(503);
      const write = ['register', 'fence', 'begin_logout', 'lookup', 'confirm_auth_revocation'].includes(action);
      const generation = write ? positiveBigint(body.generation) : null;
      const operation = write || action === 'begin_session_logout' ? string(body.operationId, uuidPattern, 36) : null;
      const token = action === 'register' ? string(body.token, /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/, 256) : null;
      const platform = action === 'register' ? string(body.platform, /^(?:ios|android)$/, 7) : null;
      const deviceName = action === 'register' && body.deviceName != null
        ? string(body.deviceName, /^[^\p{C}]*$/u, 128) : null;
      if (deviceName !== null && deviceName !== deviceName.normalize('NFC')) throw new Rejected(400);
      const nonce = action === 'enrollment-challenge' ? null : encodedBytes(body.nonce, 32);
      const signature = nonce ? encodedBytes(body.signature, 64) : null;
      const identity = await getIdentity(request.get('authorization'), issuer, claimsLookup);
      const signed = deviceSigningBytes([issuer, identity.user, identity.session, installation, action, purpose,
        keyVersion, generation, operation, nonce?.toString('base64url') ?? null, token, platform, deviceName,
        publicKey?.toString('base64url') ?? null]);
      const result = await transaction(pool, async db => {
        if (action === 'enrollment-challenge' && publicKey) {
          p256Key(publicKey);
          await requireLiveSession(db, identity);
          const challenge = randomBytes(32);
          const issued = await db.query('SELECT push_private.issue_device_enrollment($1,$2,$3,$4,$5) AS expires',
            [hash(challenge), identity.user, identity.session, installation, hash(publicKey)]);
          return { nonce: challenge.toString('base64url'), expiresAt: issued.rows[0].expires };
        }
        if (!signature || !nonce) throw new Rejected(400);
        if (action === 'enroll-installation' && publicKey) {
          if (!verify('sha256', signed, { key: p256Key(publicKey), dsaEncoding: 'ieee-p1363' }, signature)) throw new Rejected(403);
          await requireLiveSession(db, identity);
          await db.query('SELECT push_private.finish_device_enrollment($1,$2,$3,$4,$5)',
            [hash(nonce), identity.user, identity.session, installation, publicKey]);
          return { keyVersion };
        }
        const locked = await db.query('SELECT * FROM push_private.lock_device_verification_key($1)', [installation]);
        const key = locked.rows[0];
        if (key?.key_version !== keyVersion ||
            !verify('sha256', signed, { key: p256Key(key.public_key), dsaEncoding: 'ieee-p1363' }, signature)) throw new Rejected(403);
        await requireLiveSession(db, identity);
        if (action === 'challenge') {
          const challenge = randomBytes(32);
          const issued = await db.query('SELECT push_private.issue_bounded_device_challenge($1,$2,$3,$4) AS expires',
            [installation, keyVersion, purpose, hash(challenge)]);
          return { nonce: challenge.toString('base64url'), expiresAt: issued.rows[0].expires };
        }
        const actor = [installation, identity.user, identity.session];
        const proof = [keyVersion, hash(nonce)];
        let args: (string | Buffer | null)[] = [...actor, ...proof];
        if (action === 'begin_session_logout') args = [...actor, operation!, ...proof];
        if (action === 'register' || action === 'fence' || action === 'begin_logout') {
          args = [...actor, generation!, operation!, ...proof];
          if (action === 'register') args.push(token!, platform!, deviceName);
        }
        if (action === 'lookup') args = [...actor, generation!, operation!, ...proof];
        if (action === 'confirm_auth_revocation') args = [installation, identity.user, generation!, operation!, ...proof];
        const executed = await db.query(operations[action as keyof typeof operations], args);
        return { result: executed.rows[0].result };
      });
      // Only acknowledge the terminal outcome once its transaction commits.
      if (action === 'register' && result.result?.registered === false
          && result.result?.reason === 'device_token_unavailable') throw new RegistrationRejected(403);
      response.json(result);
    } catch (error) {
      if (error instanceof RegistrationRejected) {
        response.status(error.status).json({ error: 'Device verification request failed', registrationOutcome: 'rejected' });
        return;
      }
      const code = (error as { code?: string } | null)?.code;
      const status = error instanceof Rejected ? error.status : code === '42501' ? 403 :
        code === '53000' ? 429 : code === '22023' || code === '23505' ? 409 : 503;
      response.status(status).json({ error: 'Device verification request failed' });
    }
  });
  const parseError: ErrorRequestHandler = (error, _request, response, _next) => {
    response.set('Cache-Control', 'no-store').status(error?.status === 413 ? 413 : 400)
      .json({ error: 'Invalid device request body' });
  };
  router.use(parseError);
  return router;
}

const recoveryPurposes = ['discover', 'discover-binding', 'confirm', 'ack'];
const recoveryFields = new Set(['installationId', 'keyVersion', 'purpose', 'recoveryId', 'nonce', 'signature', 'issuedAt',
  'bindingUserId', 'bindingSessionId', 'bindingGeneration', 'bindingOperationId']);
// Standard P-256 generator. Used only to exercise verification for missing keys.
const dummyRecoveryKey = p256Key(Buffer.from(
  '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
  '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex'));

function recoveryLimits() {
  let window = -1;
  let active = 0;
  const counts = new Map<string, number>();
  return {
    consume(...buckets: [string, number][]) {
      const current = Math.floor(performance.now() / 60_000);
      if (current !== window) {
        window = current;
        counts.clear();
      }
      if (buckets.some(([key, maximum]) => (counts.get(key) ?? 0) >= maximum)) throw new Rejected(429);
      for (const [key] of buckets) counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    enter() {
      if (active >= 4) throw new Rejected(429);
      active++;
      return () => { active--; };
    },
  };
}

export function logoutRecoveryRouter(pool?: Pool, issuer?: string, challengeSecret?: Buffer) {
  const router = express.Router();
  const limits = recoveryLimits();
  router.use(express.json({ limit: '2kb', inflate: false }));
  for (const action of ['challenge', ...recoveryPurposes]) {
    router.post('/' + action, async (request, response) => {
      const started = performance.now();
      response.set('Cache-Control', 'no-store');
      let leave: (() => void) | undefined;
      try {
        if (!pool || !issuer || challengeSecret?.length !== 32) throw new Rejected(503);
        const source = request.socket.remoteAddress ?? 'unknown';
        const body = request.body;
        if (!request.is('application/json') || !body || Array.isArray(body) ||
            Object.keys(body).some(field => !recoveryFields.has(field))) throw new Rejected(400);
        const installation = string(body.installationId, uuidPattern, 36);
        limits.consume(['source:' + source, 60], ['pair:' + source + ':' + installation, 30]);
        const keyVersion = positiveBigint(body.keyVersion);
        const issuance = action === 'challenge';
        const purpose = issuance ? body.purpose : action;
        if (typeof purpose !== 'string' || !recoveryPurposes.includes(purpose) ||
            (!issuance && (Object.hasOwn(body, 'purpose') || Object.hasOwn(body, 'issuedAt')))) throw new Rejected(400);
        const scoped = purpose === 'discover-binding';
        const discovering = scoped || purpose === 'discover';
        const recoveryId = discovering ? null : string(body.recoveryId, uuidPattern, 36);
        if (discovering && Object.hasOwn(body, 'recoveryId')) throw new Rejected(400);
        const scopeFields = ['bindingUserId', 'bindingSessionId', 'bindingGeneration', 'bindingOperationId'];
        if (!scoped && scopeFields.some(field => Object.hasOwn(body, field))) throw new Rejected(400);
        const scopeUser = scoped ? string(body.bindingUserId, uuidPattern, 36) : null;
        const scopeSession = scoped ? string(body.bindingSessionId, uuidPattern, 36) : null;
        const scopeGeneration = scoped && Object.hasOwn(body, 'bindingGeneration') ? positiveBigint(body.bindingGeneration) : null;
        const scopeOperation = scoped && Object.hasOwn(body, 'bindingOperationId') ? string(body.bindingOperationId, uuidPattern, 36) : null;
        if (scoped && Boolean(scopeGeneration) === Boolean(scopeOperation)) throw new Rejected(400);
        const nonce = encodedBytes(body.nonce, 32);
        const signature = encodedBytes(body.signature, 64);
        const issuedAt = issuance ? string(body.issuedAt, /^[1-9][0-9]*$/, 12) : null;
        const fields = [issuer, installation, keyVersion, action, purpose, recoveryId, nonce.toString('base64url'), issuedAt];
        if (scoped) fields.push(scopeUser, scopeSession, scopeGeneration, scopeOperation);
        const signed = logoutRecoverySigningBytes(fields);
        // PostgreSQL jsonb arrays of these ASCII values use a comma and a space.
        const identityDigest = scoped ? hash(Buffer.from(`["${scopeUser}", "${scopeSession}"]`)).toString('hex') : null;
        const scopeDigest = scoped ? hash(Buffer.from(`["${identityDigest}", ${scopeGeneration ?? JSON.stringify(scopeOperation)}]`)) : null;
        const dbPurpose = scoped ? 'discover_binding' : purpose;
        leave = limits.enter();
        const result = await transaction(pool, async db => {
          const locked = await db.query('SELECT * FROM push_private.lock_device_verification_key($1)', [installation]);
          const key = locked.rows[0];
          const verificationKey = key?.key_version === keyVersion ? p256Key(key.public_key) : dummyRecoveryKey;
          const verified = verify('sha256', signed, { key: verificationKey, dsaEncoding: 'ieee-p1363' }, signature);
          if (!verified || key?.key_version !== keyVersion) throw new Rejected(403);
          if (issuance) {
            const age = Math.floor(Date.now() / 1000) - Number(issuedAt);
            if (age < -5 || age > 30) throw new Rejected(403);
            // A replay derives the same digest across processes. The DB primary
            // key prevents it creating a second row while the proof is fresh.
            const challenge = createHmac('sha256', challengeSecret).update(signed).digest();
            const issued = await db.query('SELECT push_private.issue_scoped_logout_recovery_challenge($1,$2,$3,$4,$5,$6) AS expires',
              [installation, keyVersion, dbPurpose, recoveryId, hash(challenge), scopeDigest]);
            limits.consume(['verified-global', 120], ['verified-installation:' + installation, 8]);
            return { nonce: challenge.toString('base64url'), expiresAt: issued.rows[0].expires };
          }
          const applied = await db.query('SELECT push_private.apply_scoped_logout_recovery($1,$2,$3,$4,$5,$6) AS result',
            [installation, keyVersion, dbPurpose, recoveryId, hash(nonce), scopeDigest]);
          limits.consume(['verified-global', 120]);
          return { result: applied.rows[0].result };
        }, true);
        response.json(result);
      } catch (error) {
        const code = (error as { code?: string } | null)?.code;
        const status = error instanceof Rejected ? error.status :
          code === '42501' || code === '23505' || code === '55P03' ? 403 : code === '53000' ? 429 : 503;
        leave?.();
        leave = undefined;
        if (status === 403) await delay(Math.max(0, 1600 - (performance.now() - started)));
        if (status === 429) response.set('Retry-After', '60');
        response.status(status).json({ error: 'Logout recovery request failed' });
      } finally {
        leave?.();
      }
    });
  }
  const parseError: ErrorRequestHandler = (error, _request, response, _next) => {
    response.set('Cache-Control', 'no-store').status(error?.status === 413 ? 413 : 400)
      .json({ error: 'Logout recovery request failed' });
  };
  router.use(parseError);
  return router;
}
