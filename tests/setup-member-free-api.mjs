import { Buffer } from 'node:buffer';
import { randomBytes, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const configPath = resolve('.env.member-free-api.local');
assert.ok(!existsSync(configPath), 'Dedicated config already exists; do not overwrite secrets');
function docker(args, input) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Docker ${args[0]} failed; inspect dedicated resource logs`);
  return result.stdout.trim();
}
const identity = docker(['exec', 'imahima-member-free-test-db', 'psql', '-X', '-U', 'supabase_admin',
  '-d', 'imahima_member_free_test', '-Atc', 'select current_database(),system_identifier from pg_control_system()']);
const probe = docker(['logs', 'imahima-member-free-api-db-probe']);
assert.ok(probe.includes(identity), 'Docker DB probe identity mismatch');
assert.match(identity, /^imahima_member_free_test\|\d+$/);

const secret = randomBytes(48).toString('hex');
function jwt(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'imahima-local-api-test',
    iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+86400*7 })).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
}
const config = { url: 'http://127.0.0.1:55440', api: 'http://127.0.0.1:55441',
  anon: jwt('anon'), service: jwt('service_role'), identity, password: randomBytes(24).toString('hex') };
writeFileSync(configPath, JSON.stringify(config, null, 2), { flag: 'wx' });
const authPassword = randomBytes(24).toString('hex');
const restPassword = randomBytes(24).toString('hex');
docker(['exec', '-i', 'imahima-member-free-test-db', 'psql', '-X', '-U', 'supabase_admin',
  '-d', 'imahima_member_free_test', '-v', 'ON_ERROR_STOP=1'],
  `ALTER ROLE supabase_auth_admin PASSWORD '${authPassword}';\nALTER ROLE authenticator PASSWORD '${restPassword}';\n`);
const authEnv = {
  GOTRUE_API_HOST: '0.0.0.0', GOTRUE_API_PORT: '9999', API_EXTERNAL_URL: `${config.url}/auth/v1`,
  GOTRUE_DB_DRIVER: 'postgres', GOTRUE_DB_DATABASE_URL: `postgres://supabase_auth_admin:${authPassword}@host.docker.internal:55439/imahima_member_free_test?sslmode=disable`,
  GOTRUE_SITE_URL: config.api, GOTRUE_DISABLE_SIGNUP: 'true', GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
  GOTRUE_MAILER_AUTOCONFIRM: 'true', GOTRUE_JWT_SECRET: secret, GOTRUE_JWT_AUD: 'authenticated',
  GOTRUE_JWT_ADMIN_ROLES: 'service_role', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
  GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_ISSUER: `${config.url}/auth/v1`, GOTRUE_LOG_LEVEL: 'warn',
};
const restEnv = {
  PGRST_DB_URI: `postgres://authenticator:${restPassword}@host.docker.internal:55439/imahima_member_free_test`,
  PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: secret,
};
for (const uri of [authEnv.GOTRUE_DB_DATABASE_URL, restEnv.PGRST_DB_URI]) {
  const parsed = new URL(uri);
  assert.equal(parsed.hostname, 'host.docker.internal'); assert.equal(parsed.port, '55439');
  assert.equal(parsed.pathname, '/imahima_member_free_test');
}
const gatewayEnv = { ANON_KEY: config.anon, SERVICE_ROLE_KEY: config.service };
for (const [kind, env] of Object.entries({ auth: authEnv, rest: restEnv, gateway: gatewayEnv })) {
  const file = resolve(`.env.member-free-${kind}.local`);
  writeFileSync(file, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { flag: 'wx' });
  const image = kind === 'auth' ? 'public.ecr.aws/supabase/gotrue:v2.197.0'
    : kind === 'rest' ? 'public.ecr.aws/supabase/postgrest:v16.5' : 'imahima-api:latest';
  const args = ['create', '--name', `imahima-member-free-api-${kind}`, '--network', 'imahima-member-free-api-net', '--env-file', file];
  if (kind === 'gateway') args.push('-p', '127.0.0.1:55440:8000', '--entrypoint', 'node',
    '--mount', `type=bind,source=${resolve('tests/member-free-api-gateway.mjs')},target=/verification/gateway.mjs,readonly`);
  args.push(image);
  if (kind === 'gateway') args.push('/verification/gateway.mjs');
  docker(args);
  // Inspect the actual stopped container configuration before any Auth migrations run.
  const actual = JSON.parse(docker(['inspect', `imahima-member-free-api-${kind}`]))[0];
  for (const [key, value] of Object.entries(env)) assert.ok(actual.Config.Env.includes(`${key}=${value}`));
  assert.deepEqual(Object.keys(actual.NetworkSettings.Networks), ['imahima-member-free-api-net']);
}
console.log('Dedicated keys generated; stopped Auth/REST/gateway containers verified. DB identity:', identity);
docker(['start', 'imahima-member-free-api-auth']);
console.log('Auth started. Check migration logs before starting REST/gateway.');
