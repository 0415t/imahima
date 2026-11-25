import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadMigrationLedger } from '../scripts/db/ledger.mjs';

const originalLedger = new URL('../supabase/management/migration-ledger.json', import.meta.url);
const originalMigrations = new URL('../supabase/migrations/', import.meta.url);

function unusedVersion(entries) {
  const versions = new Set(entries.map(({version}) => version));
  let version = 20990101000000n;
  while (versions.has(String(version))) version++;
  return String(version);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'imahima-ledger-'));
  const directory = pathToFileURL(join(root, 'migrations') + sep);
  const ledger = pathToFileURL(join(root, 'ledger.json'));
  mkdirSync(directory);
  const data = JSON.parse(readFileSync(originalLedger, 'utf8'));
  const entries = data.migrations;
  for (const {file} of entries) copyFileSync(new URL(file, originalMigrations), new URL(file, directory));
  t.after(() => {
    for (const file of readdirSync(directory)) unlinkSync(new URL(file, directory));
    rmdirSync(directory);
    unlinkSync(ledger);
    rmdirSync(root);
  });
  const load = () => {
    writeFileSync(ledger, JSON.stringify(data));
    return loadMigrationLedger({ledger, directory});
  };
  return {entries, directory, load};
}

test('verifies the fixed 23-migration prefix in the reviewed rebuild order', () => {
  const migrations = loadMigrationLedger();
  assert.ok(migrations.length >= 23);
  assert.equal(migrations[11].version, '20261118000000');
  assert.equal(migrations[12].version, '20261107000000');
  assert.equal(migrations[22].version, '20261121000000');
});

test('accepts Windows checkout line endings without changing verified SQL', t => {
  const {entries, directory, load} = fixture(t);
  const file = new URL(entries[0].file, directory);
  const canonical = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  writeFileSync(file, canonical.replace(/\n/g, '\r\n'));
  assert.equal(load()[0].sql, canonical);
});

test('rejects duplicate versions, missing files and unlisted migrations', t => {
  const {entries, directory, load} = fixture(t);
  entries.push(entries[0]);
  assert.throws(load, /Duplicate migration version/);
  entries.pop();
  const file = new URL(entries[0].file, directory);
  unlinkSync(file);
  assert.throws(load, /Missing migration file/);
  copyFileSync(new URL(entries[0].file, originalMigrations), file);
  writeFileSync(new URL(`${unusedVersion(entries)}_extra.sql`, directory), 'SELECT 1;');
  assert.throws(load, /Migration files missing from ledger/);
});

test('rejects unknown dependencies and changes to the frozen rebuild order', t => {
  const {entries, load} = fixture(t);
  entries[0].dependsOn.push('20990101000000');
  assert.throws(load, /Invalid migration dependency order/);
  entries[0].dependsOn.pop();
  [entries[1], entries[2]] = [entries[2], entries[1]];
  assert.throws(load, /Audited migration history or rebuild order changed/);
});

test('rejects dependencies on the same or a later migration and duplicate edges', t => {
  const {entries, load} = fixture(t);
  const entry = entries[1];
  for (const dependsOn of [[entry.version], [entries[2].version], [entries[0].version, entries[0].version]]) {
    entry.dependsOn = dependsOn;
    assert.throws(load, /Invalid migration dependency order/);
  }
});

test('detects changed statements history independently of the file hashes', t => {
  const {entries, load} = fixture(t);
  entries[0].sharedHistorySha256 = '0'.repeat(64);
  assert.throws(load, /Audited migration history/);
  entries[0].sharedHistorySha256 = null;
  assert.throws(load, /Invalid migration hashes/);
});

test('rejects removal of an otherwise valid dependency in the fixed prefix', t => {
  const {entries, load} = fixture(t);
  assert.ok(entries[1].dependsOn.length > 0);
  entries[1].dependsOn = [];
  assert.throws(load, /Audited migration dependencies or apply conditions changed/);
});

test('rejects removal or modification of a fixed apply precondition', t => {
  const {entries, load} = fixture(t);
  const {apply} = entries[0];
  assert.ok(apply.preconditions.length > 0);
  apply.preconditions = [];
  assert.throws(load, /Audited migration dependencies or apply conditions changed/);
  apply.preconditions = ['Different condition'];
  assert.throws(load, /Audited migration dependencies or apply conditions changed/);
  delete apply.preconditions;
  assert.throws(load, /Invalid migration apply conditions/);
});

test('accepts an appended migration before it has a shared history fingerprint', t => {
  const {entries, directory, load} = fixture(t);
  const sql = '-- 追加マイグレーション\nSELECT 1;\n';
  const bytes = Buffer.from(sql);
  const before = entries.length;
  const version = unusedVersion(entries);
  const entry = {
    version,
    name: 'example',
    file: `${version}_example.sql`,
    dependsOn: [entries.at(-1).version],
    gitBlob: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    sharedHistorySha256: null,
    apply: { role: 'postgres', transaction: 'required', preconditions: [] },
  };
  entries.push(entry);
  const file = new URL(entry.file, directory);
  writeFileSync(file, sql);
  const migrations = load();
  assert.equal(migrations.length, before + 1);
  assert.deepEqual(migrations.at(-1), { ...entry, sql });
  writeFileSync(file, sql.replace(/\n/g, '\r\n'));
  assert.deepEqual(load(), migrations);
});

test('rejects file edits even if both source hashes are rewritten', t => {
  const {entries, directory, load} = fixture(t);
  const entry = entries[0];
  const target = new URL(entry.file, directory);
  const edited = Buffer.from('SELECT 1;\n');
  writeFileSync(target, edited);
  assert.throws(load, /Source SHA-256 mismatch/);
  entry.sourceSha256 = createHash('sha256').update(edited).digest('hex');
  assert.throws(load, /Git blob mismatch/);
  entry.gitBlob = createHash('sha1').update(`blob ${edited.length}\0`).update(edited).digest('hex');
  assert.throws(load, /Audited migration sources changed/);
});
