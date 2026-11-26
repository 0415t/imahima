import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { Pool, type PoolClient } from 'pg';
import { authenticationErrorStatus } from './auth';
import { abortable, TIMEOUTS } from './timeouts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const publicKeyPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
const purposes = ['enroll', 'register', 'fence', 'lookup'];
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

export function deviceSigningBytes(fields: readonly (string | null)[]): Buffer {
  return Buffer.concat(['imahima-device-proof-v1', ...fields].map(field =>
    field === null ? Buffer.from('-:') : Buffer.from(`${Buffer.byteLength(field)}:${field}`)));
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

async function transaction<T>(pool: Pool, run: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  let discard = false;
  const connectionLost = () => { discard = true; };
  db.on('error', connectionLost);
  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL search_path = pg_catalog;
      SET LOCAL lock_timeout = '1500ms';
      SET LOCAL statement_timeout = '3000ms';
      SET LOCAL idle_in_transaction_session_timeout = '5s';
      SET LOCAL transaction_timeout = '6s'`);
    const role = await db.query(`SELECT session_user = 'imahima_device_api_login'
      AND NOT (r.rolsuper OR r.rolinherit OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members m
        WHERE m.member = r.oid AND (m.roleid <> 'imahima_device_verifier'::regrole OR m.admin_option OR m.inherit_option)
      ) AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = 'imahima_device_verifier'::regrole
      ) AS allowed FROM pg_catalog.pg_roles r WHERE r.rolname = session_user`);
    if (role.rows[0]?.allowed !== true) throw new Rejected(503);
    await db.query('SET LOCAL ROLE imahima_device_verifier');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    if (!discard) {
      try { await db.query('ROLLBACK'); } catch { discard = true; }
    }
    throw error;
  } finally {
    db.off('error', connectionLost);
    db.release(discard);
  }
}

const operations = {
  enroll: 'SELECT push_private.open_device_generation($1,$2,$3,$4,$5) AS result',
  register: 'SELECT push_private.register_device_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
  fence: 'SELECT push_private.fence_device_registration($1,$2,$3,$4,$5,$6,$7) AS result',
  lookup: 'SELECT push_private.get_device_operation($1,$2,$3,$4,$5,$6) AS result',
} as const;

const signedFields = ['installationId', 'keyVersion', 'nonce', 'signature'];
const operationFields = [...signedFields, 'generation', 'operationId'];
const requestFields = {
  'enrollment-challenge': ['installationId', 'publicKey'],
  'enroll-installation': ['installationId', 'publicKey', 'nonce', 'signature'],
  challenge: [...signedFields, 'purpose'],
  enroll: signedFields,
  register: [...operationFields, 'token', 'platform', 'deviceName'],
  fence: operationFields,
  lookup: operationFields,
};

export function deviceVerifierRouter(pool: Pool, issuer: string, claimsLookup: ClaimsLookup) {
  const router = express.Router();
  router.use(express.json({ limit: '4kb', inflate: false }));
  router.post('/:action', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const action = request.params.action as keyof typeof requestFields;
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
      const write = ['register', 'fence', 'lookup'].includes(action);
      const generation = write ? positiveBigint(body.generation) : null;
      const operation = write ? string(body.operationId, uuidPattern, 36) : null;
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
          const challenge = randomBytes(32);
          const issued = await db.query('SELECT push_private.issue_device_enrollment($1,$2,$3,$4,$5) AS expires',
            [hash(challenge), identity.user, identity.session, installation, hash(publicKey)]);
          return { nonce: challenge.toString('base64url'), expiresAt: issued.rows[0].expires };
        }
        if (!signature || !nonce) throw new Rejected(400);
        if (action === 'enroll-installation' && publicKey) {
          if (!verify('sha256', signed, { key: p256Key(publicKey), dsaEncoding: 'ieee-p1363' }, signature)) throw new Rejected(403);
          await db.query('SELECT push_private.finish_device_enrollment($1,$2,$3,$4,$5)',
            [hash(nonce), identity.user, identity.session, installation, publicKey]);
          return { keyVersion };
        }
        const locked = await db.query('SELECT * FROM push_private.lock_device_verification_key($1)', [installation]);
        const key = locked.rows[0];
        if (key?.key_version !== keyVersion ||
            !verify('sha256', signed, { key: p256Key(key.public_key), dsaEncoding: 'ieee-p1363' }, signature)) throw new Rejected(403);
        if (action === 'challenge') {
          const challenge = randomBytes(32);
          const issued = await db.query('SELECT push_private.issue_bounded_device_challenge($1,$2,$3,$4) AS expires',
            [installation, keyVersion, purpose, hash(challenge)]);
          return { nonce: challenge.toString('base64url'), expiresAt: issued.rows[0].expires };
        }
        const actor = [installation, identity.user, identity.session];
        const proof = [keyVersion, hash(nonce)];
        let args: (string | Buffer | null)[] = [...actor, ...proof];
        if (action === 'register' || action === 'fence') {
          args = [...actor, generation!, operation!, ...proof];
          if (action === 'register') args.push(token!, platform!, deviceName);
        }
        if (action === 'lookup') args = [installation, identity.user, generation!, operation!, ...proof];
        const executed = await db.query(operations[action as keyof typeof operations], args);
        return { result: executed.rows[0].result };
      });
      response.json(result);
    } catch (error) {
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
