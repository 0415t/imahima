import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function restrictSecrets(root) {
  const runtime = path.join(root, '.runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.chmodSync(runtime, 0o700);
  for (const name of ['signing_keys.json', 'local-status.credentials.json']) {
    const file = path.join(runtime, name);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}

export function stopDedicated(root, project, network, execute = execFileSync) {
  const ids = execute('docker', ['ps', '-aq', '--filter', `label=com.supabase.cli.project=${project}`], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  if (!ids.length) return;
  const containers = JSON.parse(execute('docker', ['inspect', ...ids], { encoding: 'utf8' }));
  // Validate every target before stopping any. Never remove containers or volumes.
  for (const c of containers) {
    assert.equal(c.Config.Labels['com.supabase.cli.project'], project);
    assert.equal(path.resolve(c.Config.Labels['com.supabase.cli.workdir']), root);
    assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [network]);
  }
  execute('docker', ['stop', ...ids], { stdio: 'ignore' });
}
