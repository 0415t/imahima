// Preload for the real server/index.ts. Restrict HTTP; never replace Auth, RPC or Push results.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { urlToHttpOptions } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const config = JSON.parse(fs.readFileSync('.env.member-free-api.local', 'utf8'));
assert.equal(config.url, 'http://127.0.0.1:55440');
assert.equal(process.env.SUPABASE_URL, config.url);
assert.equal(process.env.SUPABASE_SERVICE_ROLE_KEY, config.service);
assert.equal(process.env.HOST, '127.0.0.1');
assert.ok(['55442', '55443'].includes(process.env.PORT));
assert.equal(process.env.EXPO_ACCESS_TOKEN, '');
const audit = { blockedExternal: 0, fetches: {}, guardSelfTestPassed: false };
function allowed(url) {
  if (url.origin !== config.url) {
    audit.blockedExternal++;
    throw new Error('LOCAL_VERIFICATION_OUTBOUND_BLOCKED');
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  allowed(url);
  const response = await originalFetch(input, { ...init, redirect: 'error' });
  const key = `${url.pathname} ${response.status}`;
  audit.fetches[key] = (audit.fetches[key] ?? 0) + 1;
  return response;
};
for (const [module, protocol] of [[http, 'http:'], [https, 'https:']]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function (input, ...args) {
      const hasUrl = typeof input === 'string' || input instanceof URL;
      const options = hasUrl ? { ...urlToHttpOptions(new URL(input)),
        ...(typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) } : { ...input };
      const callback = args.find((arg) => typeof arg === 'function');
      const url = new URL(`${options.protocol ?? protocol}//${options.hostname ?? options.host ?? 'localhost'}${options.port ? `:${options.port}` : ''}`);
      allowed(url);
      return original.call(this, options, callback);
    };
  }
}
syncBuiltinESMExports();
assert.throws(() => https.request('https://exp.host/--/api/v2/push/send'), /OUTBOUND_BLOCKED/);
for (const method of ['request', 'get']) {
  assert.throws(() => http[method](config.url, { hostname: 'example.com', port: 80 }), /OUTBOUND_BLOCKED/);
  assert.throws(() => http[method](config.url, { port: 80 }), /OUTBOUND_BLOCKED/);
}
audit.blockedExternal = 0;
audit.guardSelfTestPassed = true;
// IPC delivers the normal shutdown signal handler on Windows, where child.kill is forceful.
process.on('message', (message) => {
  if (message?.type === 'local-verification-shutdown') process.emit('SIGTERM');
});
process.on('exit', () => {
  if (process.env.LOCAL_ENTRYPOINT_AUDIT === 'workers') {
    fs.writeFileSync('tests/member-free-entrypoint-worker-audit.json', JSON.stringify(audit, null, 2));
  }
});
