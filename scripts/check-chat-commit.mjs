// Read-only candidate hygiene check. Never prints matched secret values.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const tracked = git(['ls-files', '-z']);
const candidates = [...new Set([...git(['diff', '--name-only', '-z', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard', '-z'])])];
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']);
const issues = [];
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const synthetic = new Set(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']);
const forbiddenPath = file => /(^|\/)(node_modules|\.runtime)(\/|$)/.test(file) || /(^|\/)\.env(?:$|\..*local$)/.test(file) || file.startsWith('supabase/.temp/') || file.endsWith('archive-classification.local.json');
for (const file of tracked) if (forbiddenPath(file)) issues.push({ file, category: 'tracked-local-artifact' });
const patterns = [
  ['jwt-literal', /eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['secret-api-key', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['connection-uri', /postgres(?:ql)?:\/\/[^\s'"`]+/],
  ['execution-id', /\b\d{13}-[0-9a-f]{8}\b/],
  ['private-jwk', /"d"\s*:\s*"[A-Za-z0-9_-]{30,}"/],
];
function scan(file, content, source) {
  const issue = category => issues.push({ file, category, source });
  for (const [category, pattern] of patterns) if (pattern.test(content)) issue(category);
  for (const match of content.matchAll(uuid)) {
    const value = match[0].toLowerCase();
    // Explicit deterministic unit/SQL fixtures are not identifiers from a real run.
    if (!synthetic.has(value) && !/^00000000-0000-4000-8000-00000000000[1-5]$/.test(value)) {
      issue('non-fixture-uuid'); break;
    }
  }
}
for (const file of staged) scan(file, execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8' }), 'index');
for (const file of candidates) {
  const absolute = path.join(root, file);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) scan(file, fs.readFileSync(absolute, 'utf8'), 'working-tree');
}
const requiredIgnored = ['supabase/.temp/project-ref', 'verification/group-chat-local/archive-classification.local.json', 'verification/group-chat-local/.runtime/check.json', 'verification/group-chat-local/.env.local', 'node_modules/check'];
for (const file of requiredIgnored) {
  try { execFileSync('git', ['check-ignore', '--quiet', file], { cwd: root, stdio: 'ignore' }); }
  catch { issues.push({ file, category: 'missing-ignore' }); }
}
console.log(JSON.stringify({ candidates: candidates.length, staged: staged.length, issues: [...new Map(issues.map(i => [i.file + i.category + i.source, i])).values()] }, null, 2));
assert.equal(issues.length, 0, 'Commit hygiene failed; inspect filenames/categories, never print credential values');
