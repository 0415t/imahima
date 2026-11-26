import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const files = [
  'tests/test-auth-classification.ts',
  'tests/test-availability-display.ts',
  'tests/test-chat-message-notifications.ts',
  'tests/test-chat.ts',
  'tests/test-extend-from-notification.ts',
  'tests/test-free-end-action.ts',
  'tests/test-free-end-notifications.ts',
  'tests/test-groups.ts',
  'tests/test-issue36-process.mjs',
  'tests/test-logout.ts',
  'tests/test-member-free-notifications.ts',
  'tests/test-member-free-review.mjs',
  'tests/test-member-free-transport.ts',
  'tests/test-migration-ledger.mjs',
  'tests/test-notification-runtime.ts',
  'tests/test-notifications.ts',
  'tests/test-profile-toggle.ts',
  'tests/test-push-notification-service.ts',
  'tests/test-review13.ts',
  'tests/test-server-composition.ts',
  'tests/test-timeouts.ts',
  'tests/test-worker-barrier.ts',
];

const excluded = {
  'tests/test-chat-db-concurrency.mjs': ['DB', '隔離PostgreSQLの並行接続'],
  'tests/test-chat-db.ts': ['DB / Integration', '隔離PostgreSQLまたは実Auth・PostgREST'],
  'tests/test-chat-lock-timeout.mjs': ['DB', '隔離PostgreSQLのロック待ち'],
  'tests/test-chat-message-db.mjs': ['DB', '専用PostgreSQLクラスタ'],
  'tests/test-chat-push-integration.mjs': ['Integration', '専用GoTrue・PostgREST・PG17と模擬Expo'],
  'tests/test-device-registration-recovery-integration.mjs': ['Integration', '専用PG17で登録と無効化の競合を検証'],
  'tests/test-device-verifier-integration.mjs': ['Integration', '専用GoTrue・PostgREST・PG17とExpressで端末所有証明を検証'],
  'tests/test-chat-review.mjs': ['Offline（手動）', '一時ファイルとGitクローンを操作'],
  'tests/test-group-db-concurrency.mjs': ['DB', '隔離PostgreSQLの並行接続'],
  'tests/test-member-free-api.mjs': ['Integration', '専用Supabaseの実Auth・DB'],
  'tests/test-member-free-concurrency.ts': ['DB', '隔離PostgreSQLの並行接続'],
  'tests/test-member-free-entrypoint.mjs': ['Integration', '専用Supabaseとサーバー起動'],
  'tests/test-member-free-push-integration.mjs': ['Integration', '専用DBと実ワーカー、模擬Expo'],
};

const fields = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const counts = Object.fromEntries(fields.map(field => [field, 0]));

function registrationErrors() {
  const candidates = new Set(readdirSync('tests', { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && /^(?:test-.+|.+\.(?:test|spec))\.(?:[cm]?[jt]s|[jt]sx)$/u.test(entry.name))
    .map(entry => `${entry.parentPath}/${entry.name}`.replaceAll('\\', '/')));
  const errors = [];
  for (const file of new Set([...files, ...Object.keys(excluded)])) {
    if (files.includes(file) && Object.hasOwn(excluded, file)) errors.push(`Double registration: ${file}`);
    if (!candidates.delete(file)) errors.push(`Registered test file missing: ${file}`);
  }
  for (const file of [...candidates].sort()) errors.push(`Unregistered test file: ${file}`);
  return errors;
}

function readTap(stdout, file) {
  const lines = stdout.trimEnd().split(/\r?\n/u);
  const summary = Object.fromEntries(fields.map(field => [field, null]));
  const directives = [];
  const levels = [{ results: 0, plan: null }];
  let diagnostic = null;
  let valid = lines.shift() === 'TAP version 13';
  let duration = false;
  let filePlaceholder = false;
  for (const line of lines) {
    if (diagnostic !== null) {
      if (line === diagnostic + '...') diagnostic = null;
      continue;
    }
    const diagnosticStart = line.match(/^( +)---$/u);
    if (diagnosticStart) {
      diagnostic = diagnosticStart[1];
      continue;
    }
    if (/^ *# 'only' and 'runOnly' require the --test-only command-line option\.$/u.test(line)) {
      directives.push('ONLY');
      continue;
    }
    const count = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/u);
    if (count) {
      valid &&= levels.length === 1 && levels[0].plan !== null && !duration && summary[count[1]] == null;
      summary[count[1]] = Number(count[2]);
      continue;
    }
    if (/^# duration_ms \d+(?:\.\d+)?$/u.test(line)) {
      valid &&= !duration && levels[0].plan !== null && fields.every(field => summary[field] !== null);
      duration = true;
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) continue;

    const result = line.match(/^( *)(ok|not ok) (\d+) - (.*)$/u);
    const plan = line.match(/^( *)1\.\.(\d+)(?:\s+# SKIP(?:\s.*)?)?$/u);
    if ((!result && !plan) || duration) { valid = false; continue; }
    const depth = (result ?? plan)[1].length / 4;
    if (!Number.isInteger(depth) || depth >= levels.length + 1) { valid = false; continue; }
    while (levels.length > depth + 1) {
      const closed = levels.pop();
      valid &&= closed.results === closed.plan;
    }
    const level = levels[depth] ??= { results: 0, plan: null };
    if (result) {
      const directive = result[4].match(/(?<!\\)\s+# (SKIP|TODO)(?:\s.*)?$/u);
      if (directive) directives.push(directive[1]);
      if (result[2] === 'not ok' && !directive) valid = false;
      valid &&= level.plan === null && Number(result[3]) === level.results + 1;
      level.results++;
      if (depth === 0 && level.results === 1 && result[2] === 'ok') {
        filePlaceholder = result[4].replace(/\\+/g, '/') === file;
      }
    } else {
      if (plan[0].includes('# SKIP')) directives.push('SKIP');
      valid &&= level.plan === null;
      level.plan = Number(plan[2]);
    }
  }
  const emptyFile = summary.tests === 1 && levels[0].results === 1 && filePlaceholder;
  if (emptyFile) {
    summary.tests = 0;
    summary.pass = 0;
  }
  const complete = valid && duration && diagnostic === null && levels.length === 1 &&
    levels[0].results === levels[0].plan && fields.every(field => summary[field] !== null);
  return { summary, directives, emptyFile, complete };
}
// Preserve OS essentials only. DB flags, tokens, proxies and preloads are omitted.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA)$/i.test(name)));
env.TSX_DISABLE_CACHE = '1';
env.EXPO_NO_DOTENV = '1';
// Node 24.15's child context disables implicit .only filtering. Keep one
// process per file so the hard timeout can kill the process running the test.
env.NODE_TEST_CONTEXT = 'child';

const report = {
  sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  os: process.platform,
  arch: process.arch,
  node: process.versions.node,
  npm: process.env.npm_config_user_agent?.match(/\bnpm\/([^ ]+)/)?.[1] ?? null,
  status: 'running',
  errors: [],
  counts,
  files: files.map(file => ({ file, status: 'pending' })),
};

function saveReport() {
  const destination = process.env.OFFLINE_TEST_REPORT;
  if (!destination) return;
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
  renameSync(temporary, destination);
}

saveReport();
report.errors = registrationErrors();
for (const entry of report.errors.length === 0 ? report.files : []) {
  const { file } = entry;
  entry.status = 'running';
  saveReport();
  console.log(`\n=== ${file} ===`);
  const child = spawnSync(process.execPath, [
    '--import', 'tsx', '--test', '--test-isolation=none', '--test-reporter=tap',
    '--test-timeout=30000', file,
  ], { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  const { summary, directives, emptyFile, complete } = readTap(stdout, file);
  const passed = child.status === 0 && !child.signal && !child.error && complete &&
    summary.tests > 0 && summary.pass === summary.tests && directives.length === 0 &&
    ['fail', 'cancelled', 'skipped', 'todo'].every(field => summary[field] === 0);
  for (const field of fields) counts[field] += summary[field] ?? 0;
  Object.assign(entry, {
    status: passed ? 'passed' : 'failed', passed, complete, directives, emptyFile,
    counts: summary, exitCode: child.status, signal: child.signal,
    error: child.error?.code ?? null,
    timedOut: child.error?.code === 'ETIMEDOUT' || /error: 'test timed out after /u.test(stdout),
    stdout, stderr,
  });
  saveReport();
  if (!passed) console.error(`Offline test did not complete successfully: ${file}`);
}

const failed = report.errors.length > 0 || counts.tests === 0 || report.files.some(file => !file.passed);
report.status = failed ? 'failed' : 'passed';
saveReport();
for (const error of report.errors) console.error(error);
console.log(JSON.stringify({ ...report, files: report.files.map(({ stdout, stderr, ...result }) => result) }, null, 2));
if (failed) process.exitCode = 1;
