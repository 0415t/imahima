// Loaded before the production entrypoint. Only the final Expo request is mocked.
const assert = require('node:assert/strict');
const { Server: HttpServer } = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');

const origin = new URL(process.env.SUPABASE_URL);
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.protocol, 'http:');
assert.equal(origin.origin, process.env.ISSUE36_GATEWAY);
assert.equal(process.env.HOST, '127.0.0.1');
assert.equal(process.env.FREE_END_NOTIFICATIONS_ENABLED, 'false');
assert.equal(process.env.MEMBER_FREE_NOTIFICATIONS_ENABLED, 'false');
assert.equal(process.env.EXPO_ACCESS_TOKEN, '');
const expo = 'https://exp.host/--/api/v2/push/send';
const tokens = new Set(JSON.parse(process.env.ISSUE36_FAKE_TOKENS));
assert.ok(tokens.size && [...tokens].every(t => /^ExpoPushToken\[issue36_[a-f0-9]{32}\]$/.test(t)));

let blocked = 0;
const blockedKinds = [];
let blockedLoaderIpc = 0;
let validates = 0;
let release;
function deny(kind) {
  blocked++;
  blockedKinds.push(kind);
  throw new Error('ISSUE36_OUTBOUND_BLOCKED');
}

// Covers fetch/undici and ordinary Node TCP HTTP clients. Refuse DNS names,
// non-gateway loopback ports, and Unix/Windows sockets created by the server.
const connect = net.Socket.prototype.connect;
const tsxPipePath = path.join(os.tmpdir(), `tsx-${process.geteuid?.() ?? os.userInfo().username}`, `${process.ppid}.pipe`);
const tsxPipe = process.platform === 'win32' ? `\\\\?\\pipe\\${tsxPipePath}` : tsxPipePath;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const ipcPath = typeof options === 'object' && options !== null ? options.path
    : typeof options === 'string' && !/^\d+$/.test(options) ? options : undefined;
  if (ipcPath === tsxPipe) {
    blockedLoaderIpc++;
    throw new Error('ISSUE36_LOADER_IPC_BLOCKED');
  }
  if (ipcPath != null) deny('IPC other path');
  const host = typeof options === 'object' && options !== null ? options.host : args[1];
  const port = typeof options === 'object' && options !== null ? options.port : options;
  if (host !== '127.0.0.1' || Number(port) !== Number(origin.port)) deny(
    host === undefined ? 'TCP without host' : host === '127.0.0.1' ? 'TCP other loopback port' : 'TCP other host');
  return connect.apply(this, args);
};

// Express binds port 0 itself. Report the live listener without reserving a
// separate socket or changing the application entrypoint.
const emitHttp = HttpServer.prototype.emit;
HttpServer.prototype.emit = function guardedHttpEmit(event, ...args) {
  if (event === 'listening') {
    const address = this.address();
    assert.equal(address?.address, '127.0.0.1');
    assert.ok(Number.isInteger(address.port) && address.port > 0);
    process.send?.({type:'express-bound',port:address.port});
  }
  return emitHttp.call(this,event,...args);
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.href === expo) {
    assert.equal(init.method.toUpperCase(), 'POST');
    const compressed = new Headers(init.headers).get('Content-Encoding') === 'gzip';
    const messages = JSON.parse(compressed ? gunzipSync(init.body).toString() : init.body);
    assert.ok(Array.isArray(messages) && messages.length > 0);
    for (const message of messages) {
      assert.ok(tokens.has(message.to), 'Unexpected Expo destination');
      assert.equal(message.data.type, 'chat_message');
    }
    process.send?.({type:'mock-push',messages});
    return Response.json({data:messages.map(()=>({status:'ok',id:'issue36-local-mock-ticket'}))});
  }
  if (url.origin !== origin.origin || !/^\/(auth|rest)\/v1\//.test(url.pathname)) deny(
    url.origin === origin.origin ? 'HTTP other gateway route' : 'HTTP other origin');
  const isValidate = url.pathname === '/rest/v1/rpc/validate_chat_message_notification';
  const notificationId = isValidate ? JSON.parse(init.body).p_notification : undefined;
  if (notificationId && notificationId === process.env.ISSUE36_BARRIER_ID && ++validates === 2) {
    await new Promise((resolve,reject)=>{
      const abort = () => { release=undefined; reject(init.signal.reason); };
      init.signal?.throwIfAborted();
      init.signal?.addEventListener('abort',abort,{once:true});
      release=()=>{init.signal?.removeEventListener('abort',abort);release=undefined;resolve();};
      process.send?.({type:'before-final-validate'});
    });
    if (process.env.ISSUE36_SKIP_FINAL_VALIDATE === '1') throw new Error('Simulated missing final validate');
    const response = await realFetch(input,{...init,redirect:'error'});
    const [validation] = await response.clone().json();
    process.send?.({type:'final-validate-response',notificationId,status:response.status,owned:validation?.owned});
    return response;
  }
  return realFetch(input,{...init,redirect:'error'});
};

function shutdown() {
  if (!process.emit('SIGTERM')) process.exit(0);
}
process.on('disconnect',shutdown);
process.on('message', message=>{
  if (message.type === 'release-final-validate') release?.();
  if (message.type === 'shutdown') shutdown();
  if (message.type === 'guard-status') process.send?.({type:'guard-status',blocked,blockedKinds,blockedLoaderIpc});
});
assert.throws(()=>new net.Socket().connect(443,'203.0.113.1'),/ISSUE36_OUTBOUND_BLOCKED/);
assert.throws(()=>new net.Socket().connect(1,'127.0.0.1'),/ISSUE36_OUTBOUND_BLOCKED/);
const otherPipe = tsxPipe + '.unexpected';
assert.throws(()=>new net.Socket().connect(otherPipe),/ISSUE36_OUTBOUND_BLOCKED/);
assert.throws(()=>new net.Socket().connect({path:otherPipe,host:'127.0.0.1',port:Number(origin.port)}),/ISSUE36_OUTBOUND_BLOCKED/);
assert.equal(blocked,4);
blocked=0;
blockedKinds.length=0;
process.send?.({type:'guard-ready'});
