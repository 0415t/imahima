// Infrastructure checks only: no signup, message, application DDL or mutation RPC.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, '.runtime');
const project = 'imahima-chat-local';
assert.ok(process.argv.slice(2).every(a => a === '--schema'), 'Only --schema is supported');
const schemaReady = process.argv.includes('--schema');
const databaseContainer = `supabase_db_${project}`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const inspect = names => JSON.parse(docker(['inspect', ...names]));
const hash = value => createHash('sha256').update(value).digest('hex');
execFileSync(process.execPath, [path.join(root, 'local-stack.mjs'), 'status'], { stdio: 'inherit' });
const status = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
const api = new URL(status.API_URL), db = new URL(status.DB_URL);
assert.equal(api.origin, 'http://127.0.0.1:56321');
assert.equal(db.hostname, '127.0.0.1'); assert.equal(db.port, '56322'); assert.equal(db.pathname, '/postgres');
assert.ok(status.ANON_KEY && status.SERVICE_ROLE_KEY);
const names = ['db', 'auth', 'rest', 'realtime', 'kong'].map(s => `supabase_${s}_${project}`);
const containers = inspect(names);
for (const c of containers) {
  assert.equal(c.State.Running, true);
  if (c.State.Health) assert.equal(c.State.Health.Status, 'healthy');
  assert.deepEqual(Object.keys(c.NetworkSettings.Networks), ['imahima-chat-local-net']);
  for (const bindings of Object.values(c.NetworkSettings.Ports)) for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1');
}
const dbInfo = containers.find(c => c.Name === '/' + databaseContainer);
assert.equal(dbInfo.NetworkSettings.Ports['5432/tcp'][0].HostPort, '56322');
const serviceConnections = [];
for (const c of containers) {
  const env = Object.fromEntries(c.Config.Env.map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  for (const field of ['GOTRUE_DB_DATABASE_URL', 'PGRST_DB_URI']) if (env[field]) {
    const url = new URL(env[field]);
    assert.equal(url.hostname, databaseContainer); assert.equal(url.pathname, '/postgres');
    serviceConnections.push({ service: c.Name.slice(1), field, databaseContainer });
  }
  if (c.Name.includes('realtime')) { assert.equal(env.DB_HOST, databaseContainer); serviceConnections.push({ service: c.Name.slice(1), databaseContainer }); }
}
const sql = `begin read only;
select jsonb_build_object('database',current_database(),'role',current_user,
 'server_version',current_setting('server_version'),'wal_level',current_setting('wal_level'),
 'system_identifier',(select system_identifier::text from pg_control_system()),
 'publication',(select jsonb_build_object('exists',true,'all_tables',puballtables,'insert',pubinsert) from pg_publication where pubname='supabase_realtime'),
 'auth_users',(select count(*) from auth.users),
 'app_tables',(select coalesce(jsonb_agg(c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname in ('profiles','rooms','room_members','messages','room_message_events','group_mvp_rate_limits')),
 'app_functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('group_mvp_execute','chat_send_message','chat_delete_message','chat_list_messages','chat_list_message_events')));
commit;`;
const raw = execFileSync('docker', ['exec', '-i', databaseContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const identity = JSON.parse(raw.trim());
assert.equal(identity.database, 'postgres'); assert.equal(identity.role, 'postgres'); assert.equal(identity.wal_level, 'logical');
assert.equal(identity.publication?.exists, true); assert.equal(identity.publication.all_tables, false); assert.equal(identity.publication.insert, true);
assert.equal(identity.auth_users, 0);
if (schemaReady) {
  assert.deepEqual([...identity.app_tables].sort(), ['profiles','rooms','room_members','group_mvp_rate_limits','messages','room_message_events'].sort());
  assert.equal(identity.app_functions, 5);
} else { assert.deepEqual(identity.app_tables, []); assert.equal(identity.app_functions, 0); }
const identityFile = path.join(runtime, 'identity.json');
if (fs.existsSync(identityFile)) assert.equal(JSON.parse(fs.readFileSync(identityFile)).system_identifier, identity.system_identifier);
else fs.writeFileSync(identityFile, JSON.stringify(identity, null, 2), { flag: 'wx' });

const health = {};
// CLI's gateway does not expose the Realtime internal HTTP health endpoint.
// Realtime health is checked via Docker healthcheck above plus a real socket below.
for (const endpoint of ['/auth/v1/health', '/rest/v1/']) {
  const response = await fetch(new URL(endpoint, api), { headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${status.ANON_KEY}` }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  health[endpoint] = response.status; assert.equal(response.status, 200, `Local health endpoint ${endpoint}`);
  await response.arrayBuffer();
}
const jwksResponse = await fetch(new URL('/auth/v1/.well-known/jwks.json', api), { headers: { apikey: status.ANON_KEY }, signal: AbortSignal.timeout(15000), redirect: 'error' });
assert.equal(jwksResponse.status, 200);
const jwks = await jwksResponse.json();
const localSigningKey = JSON.parse(fs.readFileSync(path.join(runtime, 'signing_keys.json'), 'utf8'))[0];
assert.ok(jwks.keys.some(k => k.kid === localSigningKey.kid));
health.dedicatedSigningKeyPublished = true;
const websocketUrl = new URL('/realtime/v1/websocket', api); websocketUrl.protocol = 'ws:';
websocketUrl.searchParams.set('apikey', status.ANON_KEY); websocketUrl.searchParams.set('vsn', '1.0.0');
await new Promise((resolve, reject) => {
  const ws = new WebSocket(websocketUrl);
  const timeout = setTimeout(() => { ws.close(); reject(new Error('Local Realtime socket timeout')); }, 15000);
  ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(); };
  ws.onerror = () => { clearTimeout(timeout); reject(new Error('Local Realtime socket unavailable')); };
});
health.websocket = 'opened and closed; no channel or test user created';

// Output only counts and metadata; never export application .env values.
let preservation = 'No baseline available';
const baselineFile = path.join(runtime, 'baseline.json');
if (fs.existsSync(baselineFile)) {
  const baseline = JSON.parse(fs.readFileSync(baselineFile));
  const old = inspect(baseline.containers.map(c => c.id));
  for (const saved of baseline.containers) {
    const current = old.find(c => c.Id === saved.id); assert.ok(current, 'Existing container missing');
    assert.equal(current.Image, saved.image); assert.equal(hash(JSON.stringify(current.Config)), saved.configHash);
    assert.equal(hash(JSON.stringify(current.HostConfig)), saved.hostHash);
    const sortedMounts = mounts => [...mounts].sort((a, b) => a.Destination.localeCompare(b.Destination));
    assert.deepEqual(sortedMounts(current.Mounts), sortedMounts(saved.mounts));
    assert.deepEqual(Object.keys(current.NetworkSettings.Networks).sort(), saved.networks);
  }
  const volumes = JSON.parse(docker(['volume', 'inspect', ...baseline.volumes.map(v => v.Name)]));
  for (const saved of baseline.volumes) assert.deepEqual(volumes.find(v => v.Name === saved.Name), saved);
  for (const [file, expected] of Object.entries(baseline.files)) assert.equal(hash(fs.readFileSync(path.resolve(root, file))), expected);
  preservation = `${old.length} existing container IDs/configurations/mounts/networks and ${volumes.length} volume metadata records unchanged; protected env/link files unchanged`;
}

const envValues = {
  CHAT_LOCAL_PROJECT_ID: project, CHAT_LOCAL_DB_SYSTEM_IDENTIFIER: identity.system_identifier,
  DOTENV_CONFIG_PATH: path.join(root, '.env.local').split(path.sep).join('/'),
  SUPABASE_URL: api.origin, SUPABASE_ANON_KEY: status.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  DATABASE_URL: status.DB_URL, PORT: '56331', FREE_END_NOTIFICATIONS_WORKER_ENABLED: 'false', MEMBER_FREE_NOTIFICATIONS_WORKER_ENABLED: 'false',
};
fs.writeFileSync(path.join(root, '.env.local'), '# LOCAL ONLY. Generated from this dedicated CLI status; never import application .env.\n' + Object.entries(envValues).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n');
const report = { project, api: api.origin, databasePort: db.port, schemaReady, identity, services: containers.map(c => ({ name: c.Name.slice(1), image: c.Config.Image, running: c.State.Running, health: c.State.Health?.Status ?? 'no Docker healthcheck' })), serviceConnections, health, preservation, note: 'This verification invokes no signup, login, migration, mutation RPC or Push. Existing volume contents naturally change while their own services run; only metadata preservation is compared.' };
fs.writeFileSync(path.join(runtime, 'verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
