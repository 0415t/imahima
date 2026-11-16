// One-shot, explicit local-only application. An interrupted/failed run is never retried automatically.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { connectVerified, authSnapshot, root, runtime } from './schema-tools.mjs';
assert.deepEqual(process.argv.slice(2), ['--apply'], 'Explicit --apply required');
const stateFile = path.join(runtime, 'application-state.json');
assert.ok(!fs.existsSync(stateFile), 'Application record exists; stop and inspect instead of retrying');
const files = ['sql/00_application_base.sql', '../../supabase/migrations/20261111000000_group_management_mvp.sql', '../../supabase/migrations/20261113000000_group_chat_mvp.sql'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = files.map(file => ({ file, sql: fs.readFileSync(path.resolve(root, file), 'utf8') }));
const state = { project: 'imahima-chat-local', target: '127.0.0.1:56322/postgres', started_at: new Date().toISOString(), status: 'preflight', steps: inputs.map(i => ({ file: i.file, sha256: hash(i.sql), status: 'pending' })) };
const { client, identity, containerId } = await connectVerified();
try {
  const { rows: [preflight] } = await client.query(`select
    (select count(*) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') and c.relname in ('profiles','rooms','room_members','messages','room_message_events','group_mvp_rate_limits'))::int as existing_tables,
    (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('generate_room_key','group_mvp_execute','group_mvp_consume_rate','chat_send_message','chat_delete_message','chat_list_messages','chat_list_message_events'))::int as existing_functions,
    to_regnamespace('chat_private') as chat_schema,to_regnamespace('chat_local_support') as support_schema,
    (select count(*) from pg_trigger where tgrelid='auth.users'::regclass and tgname='chat_local_profile_created')::int as profile_trigger,
    (select count(*) from auth.users)::int as users`);
  assert.deepEqual(preflight, { existing_tables: 0, existing_functions: 0, chat_schema: null, support_schema: null, profile_trigger: 0, users: 0 });
  const before = await authSnapshot(client); assert.equal(before.users, 0);
  fs.writeFileSync(path.join(runtime, 'auth-before-schema.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
  Object.assign(state, { identity, containerId, auth_before_sha256: hash(JSON.stringify(before)) });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { flag: 'wx' });
  for (let index = 0; index < inputs.length; index++) {
    const step = state.steps[index]; step.status = 'applying'; state.status = 'applying';
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    const result = await client.query(inputs[index].sql); // Each reviewed file owns BEGIN/COMMIT.
    const commands = (Array.isArray(result) ? result : [result]).map(r => ({ command: r.command, rowCount: r.rowCount }));
    fs.writeFileSync(path.join(runtime, `schema-step-${index + 1}.json`), JSON.stringify({ file: step.file, commands }, null, 2));
    assert.equal(commands.at(-1)?.command, 'COMMIT');
    step.status = 'committed'; step.completed_at = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(`COMMITTED ${index + 1}/3: ${step.file}`);
  }
  const after = await authSnapshot(client);
  fs.writeFileSync(path.join(runtime, 'auth-after-schema.json'), JSON.stringify(after, null, 2));
  assert.deepEqual(after, before, 'Existing Auth objects changed');
  state.auth_preserved = true; state.status = 'committed'; state.completed_at = new Date().toISOString();
  // PostgREST reload only on the verified local connection. No RPC/data mutations.
  await client.query("notify pgrst, 'reload schema'");
  state.postgrest_reload_notified = true;
  for (const input of inputs) assert.equal(hash(fs.readFileSync(path.resolve(root, input.file))), hash(input.sql));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log('Existing Auth objects preserved; local PostgREST schema reload notified. No users or room/message rows created.');
} catch (error) {
  // If a file failed, roll back its still-open transaction, but never undo prior commits.
  try { await client.query('rollback'); } catch { /* Connection failure also stops work. */ }
  state.status = 'stopped'; state.failure_code = error.code ?? 'VALIDATION_FAILED';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.error(`Stopped without retry (${state.failure_code}). Inspect ignored application-state.json before any further application.`);
  process.exitCode = 1;
} finally { await client.end(); }
