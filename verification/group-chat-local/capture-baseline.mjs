// Run once before creating a new local stack. Existing snapshots are never overwritten.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(root, '.runtime/baseline.json');
assert.ok(!fs.existsSync(file), 'Baseline already exists; preserve it');
const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const ids = docker(['ps', '-aq']).split(/\s+/).filter(Boolean);
const all = ids.length ? JSON.parse(docker(['inspect', ...ids])) : [];
assert.ok(!all.some(c => c.Config.Labels?.['com.supabase.cli.project'] === 'imahima-chat-local'), 'Capture before provisioning');
const volumeNames = docker(['volume', 'ls', '-q']).split(/\s+/).filter(Boolean);
const baseline = {
  containers: all.map(c => ({ id: c.Id, name: c.Name, image: c.Image, created: c.Created, started: c.State.StartedAt,
    configHash: hash(JSON.stringify(c.Config)), hostHash: hash(JSON.stringify(c.HostConfig)), mounts: c.Mounts, networks: Object.keys(c.NetworkSettings.Networks).sort() })),
  volumes: volumeNames.length ? JSON.parse(docker(['volume', 'inspect', ...volumeNames])) : [], files: {},
};
for (const name of ['../../.env', '../../server/.env', '../../supabase/.temp/project-ref', '../../supabase/.temp/linked-project.json']) {
  const target = path.resolve(root, name); if (fs.existsSync(target)) baseline.files[name] = hash(fs.readFileSync(target));
}
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(baseline, null, 2), { flag: 'wx' });
console.log('Preservation metadata captured in ignored .runtime; no credentials exported.');
