import { Buffer } from 'node:buffer';
// Docker Desktop can ignore network host_binding_ipv4 for CLI-created ports.
// Recreate ONLY this directory's newly provisioned DB/gateway, retaining named volumes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockerSocket } from './docker-endpoint.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const project = 'imahima-chat-local';
const network = 'imahima-chat-local-net';
const socketPath = dockerSocket();
function request(method, url, value) {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = http.request({ socketPath, path: url, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => {
        if (res.statusCode >= 400) { reject(new Error(`Dedicated Docker request failed (${res.statusCode})`)); return; }
        resolve(text ? JSON.parse(text) : null);
      });
    });
    req.on('error', () => reject(new Error('Dedicated Docker socket unavailable'))); req.end(body);
  });
}
for (const service of ['db', 'kong']) {
  const name = `supabase_${service}_${project}`;
  const c = await request('GET', `/containers/${name}/json`);
  assert.equal(c.Name, '/' + name);
  assert.equal(c.Config.Labels['com.supabase.cli.project'], project);
  assert.equal(path.resolve(c.Config.Labels['com.supabase.cli.workdir']), root);
  assert.deepEqual(Object.keys(c.NetworkSettings.Networks), [network]);
  if (Object.values(c.NetworkSettings.Ports).every(bindings => (bindings ?? []).every(b => b.HostIp === '127.0.0.1'))) continue;
  if (service === 'db') assert.ok(c.Mounts.some(m => m.Name === `supabase_db_${project}` && m.Destination === '/var/lib/postgresql/data'));
  const oldName = `${name}_loopback_previous`;
  await request('POST', `/containers/${c.Id}/stop?t=30`);
  await request('POST', `/containers/${c.Id}/rename?name=${oldName}`);
  const bindings = structuredClone(c.HostConfig.PortBindings);
  for (const list of Object.values(bindings)) for (const b of list) b.HostIp = '127.0.0.1';
  const spec = { ...c.Config, Image: c.Image, HostConfig: { ...c.HostConfig, PortBindings: bindings },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: c.NetworkSettings.Networks[network].Aliases } } } };
  const created = await request('POST', `/containers/create?name=${name}`, spec);
  if (service === 'kong') {
    // CLI copies its generated routing/TLS files after docker create; they are
    // not part of the image or Config. Transfer in memory, never print secrets.
    const archive = execFileSync('docker', ['cp', `${oldName}:/home/kong`, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    execFileSync('docker', ['cp', '-', `${name}:/home`], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  await request('POST', `/containers/${created.Id}/start`);
  let ready = false;
  for (let i = 0; i < 90; i++) {
    const updated = await request('GET', `/containers/${created.Id}/json`);
    if (updated.State.Running && (!updated.State.Health || updated.State.Health.Status === 'healthy')) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(ready, `New dedicated ${service} did not become healthy; stopped predecessor retained`);
  // No volume deletion. Both IDs were created by this task, never preexisting instances.
  await request('DELETE', `/containers/${c.Id}`);
  console.log(`${name}: loopback port binding enforced; data volume retained.`);
}
