import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connectVerified, authSnapshot, root, runtime } from './schema-tools.mjs';
const expectEmpty = process.argv.includes('--expect-empty');
assert.ok(process.argv.slice(2).every(a => a === '--expect-empty'), 'Unknown option');
const reportDirectory = path.join(runtime, 'reports');
fs.mkdirSync(reportDirectory, { recursive: true });
const run = Date.now();
const state = JSON.parse(fs.readFileSync(path.join(runtime, 'application-state.json'), 'utf8'));
assert.equal(state.status, 'committed', 'Application did not complete; stop');
const { client, identity } = await connectVerified();
try {
  const result = await client.query(fs.readFileSync(path.join(root, 'sql/application_postflight.sql'), 'utf8'));
  const report = result.find(r => r.rows?.[0]?.report)?.rows[0].report;
  assert.ok(report);
  fs.writeFileSync(path.join(reportDirectory, `schema-${run}-catalog.json`), JSON.stringify(report, null, 2));
  assert.equal(report.tables.length, 6); assert.ok(report.tables.every(t => t.rls === true && t.owner === 'postgres'));
  if (expectEmpty) assert.ok(Object.values(report.rows).every(n => n === 0), 'Historical empty-schema check failed');
  for (const p of report.table_privileges) {
    if (p.role !== 'service_role') assert.equal(p.allowed, p.role === 'authenticated' && p.privilege === 'SELECT' && ['profiles', 'room_message_events'].includes(p.table));
    else if (['profiles','messages','room_message_events'].includes(p.table)) {
      const expected = p.table === 'profiles' ? p.privilege === 'SELECT' : ['SELECT','INSERT'].includes(p.privilege);
      assert.equal(p.allowed, expected);
    } else if (['SELECT','INSERT','UPDATE','DELETE'].includes(p.privilege)) assert.equal(p.allowed, true);
  }
  for (const p of report.column_privileges) {
    if (p.role !== 'service_role') assert.equal(p.allowed, p.role === 'authenticated' && p.privilege === 'SELECT' && ['profiles','room_message_events'].includes(p.table));
  }
  for (const p of report.message_column_updates) assert.equal(p.service_update, ['body','deleted_at','last_event_seq'].includes(p.column));
  assert.equal(report.rpc_privileges.length, 18);
  assert.ok(report.rpc_privileges.every(p => p.execute === (p.role === 'service_role')));
  assert.equal(report.rpc_security.length, 6);
  assert.ok(report.rpc_security.every(p => p.security_definer === false && p.owner === 'postgres' && p.config.includes('search_path=""')));
  const helper = report.membership_helper;
  assert.ok(helper.security_definer && helper.owner === 'postgres' && helper.config.includes('search_path=""') && helper.config.includes('row_security=off'));
  assert.equal(helper.anon_execute, false); assert.equal(helper.authenticated_execute, true); assert.equal(helper.service_execute, false);
  const registration = report.registration_helper;
  assert.ok(registration.security_definer && registration.owner === 'postgres' && registration.config.includes('search_path=""'));
  assert.ok(!registration.anon_execute && !registration.authenticated_execute && !registration.service_execute);
  for (const s of report.private_schemas) { assert.equal(s.create, false); assert.equal(s.usage, s.schema === 'chat_private' && s.role !== 'anon'); }
  assert.equal(report.policies.length, 2);
  assert.ok(report.policies.some(p => p.tablename === 'room_message_events' && p.cmd === 'SELECT' && p.roles.includes('authenticated') && p.qual.includes('chat_private.can_read_room')));
  assert.ok(report.policies.some(p => p.tablename === 'profiles' && p.cmd === 'SELECT' && p.roles.includes('authenticated')));
  assert.ok(report.constraints.every(c => c.validated));
  assert.ok(report.indexes.some(i => i.indexname === 'idx_room_members_user_id_room_id' && i.indexdef.includes('(user_id, room_id)')));
  assert.ok(report.indexes.some(i => i.indexname === 'messages_sender_created_at_idx' && i.indexdef.includes('(sender_id, created_at DESC)')));
  assert.deepEqual(report.triggers.map(t => t.name).sort(), ['chat_event_append_only','chat_local_profile_created','chat_message_immutable']);
  assert.ok(report.triggers.every(t => t.enabled === 'O'));
  assert.ok(report.publications.every(p => p.all_tables === false)); assert.deepEqual(report.publication_schemas, []);
  const publicPublished = report.published_tables.filter(t => t.schemaname === 'public');
  assert.equal(publicPublished.length, 1);
  assert.equal(publicPublished[0].pubname, 'supabase_realtime'); assert.equal(publicPublished[0].tablename, 'room_message_events');
  assert.deepEqual(report.event_columns, ['room_id','event_seq','message_id','event_type','created_at']);
  const before = JSON.parse(fs.readFileSync(path.join(runtime, 'auth-before-schema.json'), 'utf8'));
  const current = await authSnapshot(client);
  for (const key of ['users','sessions','refresh_tokens']) { delete before[key]; delete current[key]; }
  assert.deepEqual(current, before, 'Existing Auth object definitions not preserved');
  if (!expectEmpty) {
    const results = await client.query(fs.readFileSync(path.resolve(root, '../../supabase/tests/group_archive_postflight.sql'), 'utf8'));
    const rows = results.flatMap(r => r.rows ?? []);
    const sections = Object.fromEntries(rows.map(r => [r.section, r.data]));
    assert.equal(sections.classification.unclassified, 0);
    assert.equal(sections.column[0].is_nullable, 'NO');
    assert.equal(sections.triggers.length, 2);
    assert.ok(sections.triggers.every(t => t.tgenabled === 'O'));
    assert.ok(sections.direct_function_execution.every(p => p.allowed === false));
    assert.ok(sections.trigger_security.every(f => f.prosecdef && f.proconfig.includes('search_path=""') && f.proconfig.includes('row_security=off')));
  }
  for (const s of state.steps) assert.equal(createHash('sha256').update(fs.readFileSync(path.resolve(root, s.file))).digest('hex'), s.sha256);
  // Read OpenAPI as service_role; discover RPCs without invoking them or creating data.
  const status = JSON.parse(fs.readFileSync(path.join(runtime, 'local-status.credentials.json'), 'utf8'));
  assert.equal(status.API_URL, 'http://127.0.0.1:56321');
  const response = await fetch(new URL('/rest/v1/', status.API_URL), { headers: { apikey: status.ANON_KEY, Authorization: `Bearer ${status.SERVICE_ROLE_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200); const spec = await response.json();
  const rpcNames = ['group_mvp_execute','group_mvp_consume_rate','chat_send_message','chat_delete_message','chat_list_messages','chat_list_message_events'];
  assert.ok(rpcNames.every(name => spec.paths['/rpc/' + name]));
  const summary = { status: 'PASS', identity, tables: report.tables.map(t => t.name), all_tables_rls_enabled: true,
    management_rpcs_service_only: 6, membership_helper_authenticated_only: true, existing_auth_objects_preserved: true,
    publication_tables: ['room_message_events'], event_body_absent: true, application_rows: report.rows,
    postgrest_rpc_discovery: '6 routes visible to service_role; no RPC invoked', migration_hashes_unchanged: true };
  fs.writeFileSync(path.join(reportDirectory, `schema-${run}-verification.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, retained_data_allowed: !expectEmpty, tables: summary.tables, auth_definitions_preserved: true, archive_security_checked: !expectEmpty }));
} finally { await client.end(); }
