import assert from 'node:assert/strict';
// connect() verifies the dedicated engine, container binding and cluster identity first.
// This gate deliberately uses SELECT only: no bootstrap/default ACL writes before acceptance.
export async function assertFresh(c) {
  const relations=(await c.query("select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')")).rows;
  assert.equal(relations.length,0,'Provision only into a fresh dedicated stack; refusing replay');
  const exists=(await c.query("select to_regclass('supabase_migrations.schema_migrations') is not null present")).rows[0].present;
  if(exists) assert.equal((await c.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,0,'Provision only into a fresh dedicated stack; refusing replay');
}
