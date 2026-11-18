import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
export const root = path.dirname(fileURLToPath(import.meta.url));
export const runtime = path.join(root, '.runtime');
export async function connectVerified() {
  assert.ok(!fs.existsSync(path.join(root, 'supabase/.temp/project-ref')), 'Unexpected CLI link');
  execFileSync(process.execPath, [path.join(root, 'local-stack.mjs'), 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const status = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  assert.equal(new URL(status.API_URL).origin, 'http://127.0.0.1:56321');
  const url = new URL(status.DB_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '56322'); assert.equal(url.pathname, '/postgres');
  const name = 'supabase_db_imahima-chat-local';
  const [container] = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(container.Name, '/' + name);
  assert.equal(container.Config.Labels['com.supabase.cli.project'], 'imahima-chat-local');
  assert.equal(path.resolve(container.Config.Labels['com.supabase.cli.workdir']), root);
  assert.equal(container.State.Running, true);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), ['imahima-chat-local-net']);
  const bindings = container.NetworkSettings.Ports['5432/tcp'];
  assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, '127.0.0.1'); assert.equal(bindings[0].HostPort, '56322');
  const expected = JSON.parse(fs.readFileSync(path.join(runtime, 'identity.json'), 'utf8'));
  // Literal TCP host/port; neither ambient PG variables nor app .env is loaded.
  const client = new Client({ host: '127.0.0.1', port: 56322, database: 'postgres',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: false,
    application_name: 'imahima-chat-local-schema', connectionTimeoutMillis: 5000, query_timeout: 65000 });
  await client.connect();
  try {
    const { rows: [identity] } = await client.query(`select current_database() as database,current_user as role,
      (select system_identifier::text from pg_control_system()) as system_identifier`);
    assert.equal(identity.database, 'postgres'); assert.equal(identity.role, 'postgres');
    assert.equal(identity.system_identifier, expected.system_identifier);
    return { client, identity, containerId: container.Id };
  } catch (error) { await client.end(); throw error; }
}

// Auth object definitions/ACLs are compared, never password/session row values.
// The one newly added application trigger is excluded from the old-object view.
export async function authSnapshot(client) {
  await client.query('begin read only');
  try {
    const { rows: [row] } = await client.query(`select jsonb_build_object(
      'namespace',(select jsonb_build_object('oid',oid,'owner',nspowner,'acl',nspacl) from pg_namespace where nspname='auth'),
      'relations',(select jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'kind',c.relkind,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) order by c.oid) from pg_class c where c.relnamespace='auth'::regnamespace),
      'columns',(select jsonb_agg(jsonb_build_object('table',a.attrelid,'number',a.attnum,'name',a.attname,'type',a.atttypid,'typmod',a.atttypmod,'notnull',a.attnotnull,'acl',a.attacl,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where c.relnamespace='auth'::regnamespace and a.attnum>0 and not a.attisdropped),
      'constraints',(select jsonb_agg(jsonb_build_object('oid',oid,'definition',pg_get_constraintdef(oid)) order by oid) from pg_constraint where connamespace='auth'::regnamespace),
      'functions',(select jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,'definition',pg_get_functiondef(p.oid)) order by p.oid) from pg_proc p where p.pronamespace='auth'::regnamespace and p.prokind='f'),
      'triggers',(select jsonb_agg(jsonb_build_object('oid',t.oid,'definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='auth'::regnamespace and not t.tgisinternal and t.tgname<>'chat_local_profile_created'),
      'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p where p.schemaname='auth'),
      'users',(select count(*) from auth.users),'sessions',(select count(*) from auth.sessions),'refresh_tokens',(select count(*) from auth.refresh_tokens)
    ) as snapshot`);
    await client.query('commit'); return row.snapshot;
  } catch (error) { await client.query('rollback'); throw error; }
}
