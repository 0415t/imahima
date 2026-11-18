import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Follow Docker CLI precedence, including DOCKER_CONTEXT overriding DOCKER_HOST.
export function dockerSocket(env = process.env, execute = execFileSync) {
  let endpoint;
  if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) endpoint = env.DOCKER_HOST;
  else {
    const context = env.DOCKER_CONTEXT || execute('docker', ['context', 'show'], { encoding: 'utf8' }).trim();
    endpoint = JSON.parse(execute('docker', ['context', 'inspect', context], { encoding: 'utf8' }))[0].Endpoints.docker.Host;
  }
  assert.ok(endpoint.startsWith('unix://') || endpoint.startsWith('npipe://'),
    'Local verification requires a Docker unix socket or named pipe; TCP/SSH endpoints are unsupported');
  return endpoint.startsWith('unix://') ? endpoint.slice(7) : endpoint.slice(8).replaceAll('/', '\\');
}
