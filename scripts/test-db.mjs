import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const image = 'docker.io/library/postgres:16.16-bookworm';
const data = '/var/lib/postgresql/data';
const label = 'imahima.backend-db.run';
const setup = [
  'supabase/tests/fixtures/group_mvp_schema.sql',
  'supabase/migrations/20261111000000_group_management_mvp.sql',
  'supabase/tests/fixtures/chat_mvp_environment.sql',
  'supabase/migrations/20261113000000_group_chat_mvp.sql',
  'supabase/migrations/20261017000000_create_user_device_tokens.sql',
  'supabase/tests/fixtures/device_registration_legacy_row.sql',
  'supabase/migrations/20261125000000_device_registration_recovery_foundation.sql',
];
const required = {
  'group_mvp.test.sql': 3,
  'group_availability.test.sql': 2,
  'group_chat_mvp.test.sql': 8,
  'logout_device_tokens.test.sql': 3,
  'device_registration_recovery.test.sql': 3,
};
const deferred = {
  'extend_from_notification.test.sql': '通知からの延長RPCとAuth互換fixture',
  'free_end_notification_claims.test.sql': '終了前通知claimとAuth互換fixture',
  'group_timer_notifications.test.sql': '実タイマー・通知RPCと全migration',
  'member_free_notifications.test.sql': '暇ON通知outboxとAuth互換fixture',
  'notification_processing_retry.test.sql': '通知claimとタイマー修正migration',
  'profile_write_permissions.test.sql': 'プロフィール生成トリガーと通知RPC',
};

const recovery = process.argv[2] === '--cleanup';
const runId = randomUUID();
const reportPath = resolve(process.env.DB_TEST_REPORT ?? `.runtime/backend-db/${runId}/report.json`);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA)$/iu.test(name)));
const localEndpoints = new Set([
  'unix:///var/run/docker.sock', 'unix:///run/docker.sock',
  'npipe:////./pipe/docker_engine', 'npipe:////./pipe/dockerDesktopLinuxEngine',
]);

function save(report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const temporary = reportPath + '.' + runId + '.tmp';
  writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n');
  renameSync(temporary, reportPath);
}

const sqlErrors = {
  '42601': 'SQL syntax error',
  '42P01': 'Undefined table',
  '42501': 'Insufficient privilege',
  '55P03': 'Lock unavailable or lock timeout',
  '57014': 'Query cancelled or statement timeout',
  P0001: 'SQL exception',
  P0004: 'PL/pgSQL assertion failed',
};

function diagnostics(stderr) {
  // Verbose psql/Docker output can contain SQL values, connection strings or
  // credentials. Preserve only validated identifiers and fixed descriptions.
  const sql = stderr.match(/^(?:psql:<stdin>:(\d{1,9}):\s*|psql:\s*)?(?:ERROR|FATAL):\s+([0-9A-Z]{5}):?(?:\s|$)/mu);
  if (sql) {
    const [, line, state] = sql;
    const message = sqlErrors[state] ?? (state.startsWith('08') ? 'SQL connection failure' : 'PostgreSQL error');
    return { sqlstate: state, stderr: `${message} (SQLSTATE ${state})${line ? ` at input line ${line}` : ''}` };
  }
  const categories = [
    [/permission denied|access is denied/iu, 'Docker or PostgreSQL permission denied'],
    [/cannot connect to the docker daemon|failed to connect to the docker api|error during connect/iu, 'Docker engine connection failed'],
    [/no such image|manifest unknown|pull access denied/iu, 'PostgreSQL image unavailable'],
    [/no such container|container .* is not running/iu, 'Test container unavailable'],
    [/connection to server .* failed|could not connect to server|connection refused/iu, 'PostgreSQL socket connection failed'],
  ];
  const category = categories.find(([pattern]) => pattern.test(stderr));
  return { sqlstate: null, stderr: category?.[1] ?? (stderr ? 'Unclassified diagnostic omitted' : '') };
}

function command(args, input, timeout = 10_000) {
  const start = Date.now();
  const child = spawnSync('docker', args, {
    env, input, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
    windowsHide: true, maxBuffer: 1024 * 1024,
  });
  const { sqlstate, stderr } = diagnostics((child.stderr ?? '').slice(0, 4096));
  return {
    ok: child.status === 0 && !child.signal && !child.error,
    exitCode: child.status, signal: child.signal,
    timedOut: child.error?.code === 'ETIMEDOUT',
    error: child.error?.code ?? sqlstate,
    stderr,
    durationMs: Date.now() - start, stdout: child.stdout ?? '',
  };
}

function checked(result, stage) {
  if (!result.ok) {
    const { stdout: omitted, ...details } = result;
    void omitted;
    throw Object.assign(new Error(stage), { details });
  }
  return result.stdout.trim();
}

function localDocker() {
  if (['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].some(key => process.env[key])) {
    throw new Error('Docker endpoint overrides are not supported');
  }
  const context = checked(command(['context', 'show']), 'Docker context unavailable');
  const endpoint = checked(command(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}', context]),
    'Docker context inspection failed');
  if (!localEndpoints.has(endpoint)) throw new Error('Docker context is not an approved local socket');
  const docker = (args, input, timeout) => command(['--host', endpoint, ...args], input, timeout);
  if (checked(docker(['info', '--format', '{{.OSType}}']), 'Local Docker unavailable') !== 'linux') {
    throw new Error('A local Linux Docker engine is required');
  }
  return { endpoint, docker };
}

function inspect(docker, id, token) {
  const info = JSON.parse(checked(docker(['container', 'inspect', id]), 'Container inspection failed'))[0];
  if (info?.Id !== id || info.Config?.Labels?.[label] !== token) {
    throw new Error('Container ownership verification failed');
  }
  return info;
}

const cidPath = token => reportPath + '.' + token + '.cid';

function cleanup(report, docker) {
  const cid = cidPath(report.runId);
  if (!existsSync(cid)) return;
  const id = readFileSync(cid, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid container ID');
  const found = checked(docker(['container', 'ls', '-aq', '--no-trunc', '--filter', 'id=' + id]),
    'Container presence check failed');
  if (found) {
    if (found !== id) throw new Error('Container listing did not match the recorded ID');
    inspect(docker, id, report.runId);
    checked(docker(['container', 'rm', '--force', id]), 'Container cleanup failed');
  }
  report.cleanup = 'passed';
}

function validateTests() {
  const candidates = new Set(readdirSync('supabase/tests', { recursive: true, withFileTypes: true })
    .filter(entry => !entry.isDirectory() && entry.name.endsWith('.test.sql'))
    .map(entry => (entry.parentPath + '/' + entry.name).replaceAll('\\', '/').slice('supabase/tests/'.length)));
  for (const file of [...Object.keys(required), ...Object.keys(deferred)]) {
    if (Object.hasOwn(required, file) && Object.hasOwn(deferred, file)) {
      throw new Error('Double registered SQL test: ' + file);
    }
    if (!candidates.delete(file)) throw new Error('Registered SQL test missing: ' + file);
  }
  if (candidates.size) throw new Error('Unregistered SQL test: ' + [...candidates].sort().join(', '));
  if (Object.keys(required).length === 0) throw new Error('No required SQL tests');
}

function psql(docker, id, args, input, timeout) {
  return docker(['exec', '-i', '--env', 'PGCONNECT_TIMEOUT=3', '--env',
    'PGOPTIONS=-c statement_timeout=30000 -c lock_timeout=5000 -c plpgsql.check_asserts=on',
    id, 'psql', '-X', '-w', '-A', '-t', '-h', '/var/run/postgresql', '-U', 'postgres',
    '-d', 'imahima_ci', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', ...args], input, timeout);
}

function runSql(report, entry, docker, id, token, blocks) {
  entry.status = 'running';
  save(report);
  try {
    const sql = readFileSync(entry.file, 'utf8');
    if (blocks !== undefined && /^\s*--\s*(?:skip|todo)\b/imu.test(sql)) {
      throw new Error('Skip or TODO directive in required SQL');
    }
    const marker = 'IMAHIMA_SQL_COMPLETE_' + token;
    const { stdout, ...result } = psql(docker, id, ['-f', '-'], sql + '\n\\echo ' + marker + '\n', 90_000);
    Object.assign(entry, result);
    const lines = stdout.trimEnd().split(/\r?\n/u);
    entry.completed = lines.at(-1) === marker && lines.filter(line => line === marker).length === 1;
    if (!result.ok || !entry.completed) throw new Error('SQL execution did not complete');
    if (blocks !== undefined) {
      entry.blocks = lines.filter(line => line === 'DO').length;
      entry.rollback = lines.at(-2) === 'ROLLBACK';
      if (entry.blocks !== blocks || !entry.rollback) throw new Error('SQL verification evidence mismatch');
    }
    entry.status = 'passed';
  } catch (error) {
    entry.status = 'failed';
    entry.error ??= error.message;
    throw error;
  } finally {
    save(report);
  }
}

if (recovery) {
  if (!process.env.DB_TEST_REPORT) throw new Error('DB_TEST_REPORT is required for recovery');
  if (!existsSync(reportPath)) process.exit(0);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!/^[a-f0-9-]{36}$/u.test(report.runId)) throw new Error('Invalid report run ID');
  if (!existsSync(cidPath(report.runId)) || report.cleanup === 'passed') process.exit(0);
  try {
    const { endpoint, docker } = localDocker();
    if (endpoint !== report.endpoint) throw new Error('Docker endpoint changed before recovery');
    cleanup(report, docker);
  } catch (error) {
    report.cleanup = 'failed';
    report.cleanupError = error.message;
    process.exitCode = 1;
  } finally {
    if (report.status === 'running') {
      report.status = 'interrupted';
      process.exitCode = 1;
    }
    save(report);
  }
} else {
  const report = {
    runId, image, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', env }).trim(),
    os: process.platform, arch: process.arch, node: process.versions.node,
    status: 'running', cleanup: 'not-needed',
    setup: setup.map(file => ({ file, status: 'pending' })),
    tests: Object.keys(required).map(file => ({ file: 'supabase/tests/' + file, status: 'pending' })),
  };
  let docker;
  save(report);
  try {
    validateTests();
    const local = localDocker();
    docker = local.docker;
    report.endpoint = local.endpoint;
    save(report);
    const id = checked(docker(['create', '--cidfile', cidPath(runId), '--label', label + '=' + runId,
      '--network', 'none', '--tmpfs', data + ':rw,nosuid,nodev,size=256m',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=imahima_ci',
      image, '-c', 'wal_level=logical', '-c', 'listen_addresses='], undefined, 120_000), 'Container creation failed');
    if (!/^[a-f0-9]{64}$/u.test(id) || readFileSync(cidPath(runId), 'utf8').trim() !== id) {
      throw new Error('Container creation ID mismatch');
    }
    const info = inspect(docker, id, runId);
    const host = info.HostConfig;
    if (info.Config.Image !== image || host.NetworkMode !== 'none' || host.PublishAllPorts ||
        Object.keys(host.PortBindings ?? {}).length || host.Binds?.length ||
        !Object.hasOwn(host.Tmpfs ?? {}, data) ||
        info.Mounts?.some(mount => mount.Type !== 'tmpfs' || mount.Destination !== data)) {
      throw new Error('Container isolation verification failed');
    }
    report.isolation = { containerId: id, network: 'none', publishedPorts: 0, data: 'tmpfs' };
    save(report);
    checked(docker(['start', id]), 'Container startup failed');
    const deadline = Date.now() + 30_000;
    let ready = false;
    let readiness;
    while (!ready && Date.now() < deadline) {
      // The entrypoint also starts a temporary postmaster, so wait for the final PID 1.
      readiness = docker(['exec', id, 'sh', '-c', 'test "$(cat /proc/1/comm)" = postgres']);
      if (readiness.ok) {
        readiness = psql(docker, id, ['-c',
          "select current_database(), current_setting('server_version_num'), current_setting('wal_level'), current_setting('plpgsql.check_asserts')"],
        undefined, 5_000);
        if (readiness.ok) {
          if (readiness.stdout.trim() !== 'imahima_ci|160016|logical|on') throw new Error('SQL environment mismatch');
          ready = true;
        }
      }
      if (!ready) await delay(500);
    }
    if (!ready) {
      if (readiness) checked(readiness, 'Database readiness timeout');
      throw new Error('Database readiness timeout');
    }
    for (const entry of report.setup) runSql(report, entry, docker, id, runId);
    for (const entry of report.tests) runSql(report, entry, docker, id, runId, required[entry.file.split('/').at(-1)]);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error.message;
    if (error.details) report.failure = error.details;
  } finally {
    if (docker) {
      try {
        cleanup(report, docker);
      } catch (error) {
        report.cleanup = 'failed';
        report.cleanupError = error.message;
        report.status = 'failed';
      }
    }
    save(report);
  }
  console.log(`backend-db: ${report.status} (${report.tests.filter(entry => entry.status === 'passed').length}/${report.tests.length}); report: ${reportPath}`);
  if (report.error) console.error(report.error);
  if (report.cleanupError) console.error(report.cleanupError);
  if (report.status !== 'passed') process.exitCode = 1;
}
