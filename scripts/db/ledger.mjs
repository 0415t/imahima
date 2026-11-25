import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ledgerUrl = new URL('../../supabase/management/migration-ledger.json', import.meta.url);
const migrationsUrl = new URL('../../supabase/migrations/', import.meta.url);
const filePattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const hexHash = /^[a-f0-9]{64}$/;
const auditedCount = 23;
// Pin the ordered version/name/history-hash tuples from the reviewed #36
// postflight SQL. These hashes describe stored statements, not source bytes.
const auditedHistory = 'c8a6652a4fd252e9008644032d5d1147782160557adce8f328108a4bcbfe1e59';
const auditedSources = '7e17af74ee1ef2bbbec8a6883a8967d055a9eeaaf5a9f5aa88d467ba0a2d09b8';
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function checkedSource(entry, bytes) {
  // Normalize checkout CRLF without decoding or replacing any other bytes.
  const source = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  requireCondition(digest(source) === entry.sourceSha256, `Source SHA-256 mismatch: ${entry.file}`);
  const gitObject = Buffer.concat([Buffer.from(`blob ${source.length}\0`), source]);
  requireCondition(digest(gitObject, 'sha1') === entry.gitBlob, `Git blob mismatch: ${entry.file}`);
  return source.toString('utf8');
}

export function loadMigrationLedger({ ledger = ledgerUrl, directory = migrationsUrl } = {}) {
  const entries = JSON.parse(readFileSync(ledger, 'utf8'));
  requireCondition(entries?.schemaVersion === 1 && Array.isArray(entries.migrations), 'Invalid migration ledger');
  const files = new Set(readdirSync(directory, { withFileTypes: true })
    .filter(file => /\.sql$/i.test(file.name))
    .map(file => {
      requireCondition(file.isFile() && filePattern.test(file.name), `Invalid migration file: ${file.name}`);
      return file.name;
    }));
  const seen = new Set();
  const migrations = entries.migrations.map((entry, index) => {
    const match = typeof entry?.file === 'string' && entry.file.match(filePattern);
    requireCondition(match && match[1] === entry.version && match[2] === entry.name, 'Invalid migration identity');
    requireCondition(!seen.has(entry.version), `Duplicate migration version: ${entry.version}`);
    requireCondition(files.delete(entry.file), `Missing migration file: ${entry.file}`);
    requireCondition(Array.isArray(entry.dependsOn) && new Set(entry.dependsOn).size === entry.dependsOn.length
      && entry.dependsOn.every(version => seen.has(version)), `Invalid migration dependency order: ${entry.file}`);
    const validHistory = entry.sharedHistorySha256 === null
      ? index >= auditedCount
      : typeof entry.sharedHistorySha256 === 'string' && hexHash.test(entry.sharedHistorySha256);
    requireCondition(typeof entry.gitBlob === 'string' && /^[a-f0-9]{40}$/.test(entry.gitBlob)
      && typeof entry.sourceSha256 === 'string' && hexHash.test(entry.sourceSha256)
      && validHistory,
    `Invalid migration hashes: ${entry.file}`);
    requireCondition(entry.apply?.role === 'postgres' && entry.apply.transaction === 'required'
      && Array.isArray(entry.apply.preconditions) && entry.apply.preconditions.every(note => typeof note === 'string' && note.trim()),
    `Invalid migration apply conditions: ${entry.file}`);
    const sql = checkedSource(entry, readFileSync(new URL(entry.file, directory)));
    seen.add(entry.version);
    return { ...entry, sql };
  });
  requireCondition(files.size === 0, `Migration files missing from ledger: ${[...files].sort().join(', ')}`);
  const audited = migrations.slice(0, auditedCount);
  const history = audited.map(entry => [entry.version, entry.name, entry.sharedHistorySha256]);
  requireCondition(digest(JSON.stringify(history)) === auditedHistory, 'Audited migration history or rebuild order changed');
  const sources = audited.map(entry => [entry.version, entry.gitBlob, entry.sourceSha256]);
  requireCondition(digest(JSON.stringify(sources)) === auditedSources, 'Audited migration sources changed');
  return migrations;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    console.log(`Migration ledger verified: ${loadMigrationLedger().length} files`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
