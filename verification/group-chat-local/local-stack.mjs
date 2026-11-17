import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { dockerSocket } from './docker-endpoint.mjs';
import { restrictSecrets, stopDedicated } from './stack-safety.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const action = process.argv[2];
assert.ok(['start', 'stop', 'status'].includes(action), 'Use start, stop or status only');
const project = 'imahima-chat-local';
const network = 'imahima-chat-local-net';
const config = fs.readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
assert.match(config, /^project_id = "imahima-chat-local"$/m);
assert.match(config, /\[api\]\s+enabled = true\s+port = 56321/);
assert.match(config, /\[db\]\s+port = 56322/);
assert.match(config, /\[db.migrations\]\s+enabled = false/);
assert.match(config, /\[db.seed\]\s+enabled = false/);
assert.ok(!config.includes('.supabase.co'), 'Hosted Supabase hosts are forbidden');
assert.ok(!fs.existsSync(path.join(root, 'supabase/.temp/project-ref')), 'Do not link this directory');
const migrations = path.join(root, 'supabase/migrations');
assert.ok(!fs.existsSync(migrations) || fs.readdirSync(migrations).length === 0, 'Infrastructure-only directory must not contain app migrations');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/supabase/package.json'))).version, '3.1.0');
dockerSocket(); // Reject unsupported endpoints before provisioning anything.
restrictSecrets(root);
const keys = path.join(root, '.runtime/signing_keys.json');
if (action === 'start' && !fs.existsSync(keys)) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(keys, JSON.stringify([{ ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), alg: 'ES256', use: 'sig', key_ops: ['sign', 'verify'] }], null, 2), { flag: 'wx', mode: 0o600 });
}
// Do not inherit hosted credentials or load either application .env file.
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(SUPABASE_|EXPO_PUBLIC_|PG[A-Z_]|DATABASE_URL$|OPENAI_API_KEY$|S3_)/.test(key)) delete env[key];
env.SUPABASE_TELEMETRY_DISABLED = '1';
const args = [path.join(root, 'node_modules/supabase/dist/supabase.js'), '--workdir', root, '--agent', 'no', action];
if (action === 'start') {
  const existing = execFileSync('docker', ['network', 'ls', '--filter', `name=^${network}$`, '--format', '{{.Name}}'], { encoding: 'utf8' }).trim();
  if (!existing) execFileSync('docker', ['network', 'create', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', '--label', 'imahima.purpose=group-chat-local', network], { stdio: 'ignore' });
  const info = JSON.parse(execFileSync('docker', ['network', 'inspect', network], { encoding: 'utf8' }))[0];
  assert.equal(info.Internal, false);
  assert.equal(info.Labels['imahima.purpose'], 'group-chat-local');
  assert.equal(info.Options['com.docker.network.bridge.host_binding_ipv4'], '127.0.0.1');
  args.push('--network-id', network, '--exclude', 'studio,postgres-meta,storage-api,imgproxy,edge-runtime,logflare,vector,mailpit,supavisor');
}
if (action === 'stop') args.push('--project-id', project); // Never --all or --no-backup.
if (action === 'status') args.push('--output', 'json');
const redact = value => value.replace(/eyJ[A-Za-z0-9_.-]+/g, '[REDACTED JWT]').replace(/sb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, '[REDACTED API KEY]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[REDACTED DB URL]');
let stdout = '', stderr = '';
console.log(`${action}: dedicated project ${project}; credentials are not printed or written to logs.`);
const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let interrupted = false;
function failStart() {
  try { stopDedicated(root, project, network); console.error('Startup failed; verified dedicated containers stopped; volumes retained.'); }
  catch { console.error('Automatic stop failed. Manually stop ONLY the verified imahima-chat-local stack before proceeding (no volume deletion).'); }
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  child.kill(signal);
});
child.stdout.on('data', data => { stdout += data; });
child.stderr.on('data', data => { stderr += data; });
child.on('error', () => { console.error('CLI launch failed; inspect private logs.'); process.exitCode = 1; });
child.on('close', code => {
  if (action === 'status' && code === 0) {
    const credentials = JSON.parse(stdout);
    // Explicit secret configuration artifact, separate from diagnostic logs.
    fs.writeFileSync(path.join(root, '.runtime/local-status.credentials.json'), JSON.stringify(credentials, null, 2), { mode: 0o600 });
    stdout = JSON.stringify({ API_URL: credentials.API_URL, credentials: 'stored in ignored local-status.credentials.json' });
  }
  fs.writeFileSync(path.join(root, `.runtime/${action}.stdout.log`), redact(stdout));
  fs.writeFileSync(path.join(root, `.runtime/${action}.stderr.log`), redact(stderr));
  // Retain earlier diagnostic files with any legacy CLI credentials redacted.
  for (const name of ['start.stdout.log','start.stderr.log','stop.stdout.log','stop.stderr.log']) {
    const file = path.join(root, '.runtime', name);
    if (fs.existsSync(file)) fs.writeFileSync(file, redact(fs.readFileSync(file, 'utf8')));
  }
  if (action === 'start' && (code !== 0 || interrupted)) { failStart(); return; }
  if (code === 0 && action === 'start') {
    try { execFileSync(process.execPath, [path.join(root, 'bind-loopback.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { console.error('Dedicated loopback binding failed.'); failStart(); return; }
  }
  console.log(`${action}: ${code === 0 ? 'completed' : 'failed'} (exit ${code}).`);
  process.exitCode = code ?? 1;
});
