import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { transactionBody } from '../../verification/issue35/sql-transactions.mjs';

const images = {
  db: 'public.ecr.aws/supabase/postgres:17.11.0.011',
  auth: 'public.ecr.aws/supabase/gotrue:v2.197.0',
  rest: 'public.ecr.aws/supabase/postgrest:v16.5',
};
const versions = [
  '20261001000000','20261006000000','20261017000000','20261104000000','20261105000000','20261105000001',
  '20261105000002','20261106000000','20261106000001','20261111000000','20261111000001','20261118000000',
  '20261107000000','20261110000000','20261117000001','20261117000000','20261112000000','20261118000001',
  '20261113000000','20261118000002','20261116000000','20261118000003','20261121000000',
];
export const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA)$/i.test(key)));

export async function waitFor(check, label, signal, timeout = 15000, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await check();
    if (result) return result;
    await delay(interval, undefined, { signal });
  }
  throw new Error(`Timed out: ${label}`);
}

export function createStack(signal, { allowSignup = false } = {}) {
  const label = 'imahima.issue36.run';
  const run = randomUUID();
  const networkName = 'imahima-issue36-' + run;
  const database = 'postgres';
  const secret = randomBytes(48).toString('hex');
  const dbPassword = randomBytes(24).toString('hex');
  const authPassword = randomBytes(24).toString('hex');
  const restPassword = randomBytes(24).toString('hex');
  const relays = new Set();
  let network, gateway, identity, db;

  function command(args, { input, extra = {}, allowFailure = false } = {}) {
    const child = spawnSync('docker', args, {
      env: { ...cleanEnv, ...extra }, input, encoding: 'utf8', timeout: 45000, windowsHide: true,
    });
    if (child.status !== 0 && !allowFailure) {
      // Docker setup failures may echo credentials. Only SQL errors from this fixed
      // synthetic database are displayed, with no SQL text or detail lines.
      const reason = args.includes('psql')
        ? (child.stderr?.split(/\r?\n/).find(line => /^ERROR:/.test(line)) ?? '').replace(
          /(?:postgres(?:ql)?:\/\/\S+|[a-f0-9]{32,})/gi, '[redacted]')
        : '';
      throw new Error(`Docker ${args[args[0] === '--host' ? 2 : 0]} failed (${child.error?.code ?? child.status}) ${reason}`);
    }
    const operation = args[0] === '--host' ? args.slice(2) : args;
    if (process.env.ISSUE36_FAIL_CONTAINER_LIST === '1' && operation[0] === 'ps') {
      throw new Error('Simulated Docker container listing failure');
    }
    const fault = process.env.ISSUE36_SIMULATE_LOST_CREATE;
    if (child.status === 0 && (
      (fault === 'network' && operation[0] === 'network' && operation[1] === 'create') ||
      (fault === 'container' && operation[0] === 'create')
    )) throw new Error(`Simulated Docker ${fault} create result lost`);
    return child.status === 0 ? child.stdout.trim() : null;
  }
  const context = command(['context', 'show']);
  const host = command(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
  assert.ok(['npipe:////./pipe/docker_engine','npipe:////./pipe/dockerDesktopLinuxEngine',
    'unix:///var/run/docker.sock','unix:///run/docker.sock'].includes(host), 'Local Docker socket required');
  const docker = (args, opts) => command(['--host', host, ...args], opts);
  assert.equal(docker(['info', '--format', '{{.OSType}}']), 'linux');

  const nameOf = kind => `${networkName}-${kind}`;
  function inspect(id) {
    const [container] = JSON.parse(docker(['inspect', id]));
    assert.ok(container.Id === id && container.Config.Labels[label] === run, 'Container ownership mismatch');
    return container;
  }
  function create(kind, vars, options = [], args = []) {
    signal?.throwIfAborted();
    const id = docker(['create','--pull=never','--name',nameOf(kind),'--label',`${label}=${run}`,
      '--network',network, '--network-alias',kind, ...options,
      ...Object.keys(vars).flatMap(key => ['--env',key]), images[kind], ...args], {extra: vars});
    assert.match(id, /^[a-f0-9]{64}$/);
    const meta = inspect(id);
    assert.deepEqual(Object.keys(meta.NetworkSettings.Networks),[networkName]);
    assert.ok(!meta.HostConfig.PublishAllPorts && !meta.HostConfig.Binds?.length);
    assert.ok(meta.Mounts.every(m => m.Type === 'tmpfs' && kind === 'db' && m.Destination === '/var/lib/postgresql/data'));
    for (const [key,value] of Object.entries(vars)) {
      assert.ok(meta.Config.Env.includes(`${key}=${value}`), 'Container environment mismatch');
    }
    const ports = Object.values(meta.HostConfig.PortBindings ?? {}).flat();
    assert.equal(ports.length, 0, 'Dedicated containers must not publish any ports');
    return id;
  }
  function admin(input, allowFailure = false) {
    return docker(['exec','-i',db,'psql','-X','-w','-h','/var/run/postgresql','-U','supabase_admin',
      '-d',database,'-Atq','-v','ON_ERROR_STOP=1'],{input,allowFailure});
  }
  const identityQuery = `SELECT current_database(),system_identifier,current_setting('server_version_num'),
    (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) FROM pg_control_system();`;
  function verifyIdentity() {
    assert.equal(admin(identityQuery), identity, 'Database identity changed');
  }
  function query(input) {
    verifyIdentity();
    return admin(input);
  }
  function key(role) {
    const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
    const claims = Buffer.from(JSON.stringify({role, iss:'supabase', exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
    return `${header}.${claims}.${createHmac('sha256',secret).update(`${header}.${claims}`).digest('base64url')}`;
  }
  function relay(url, {method='GET',headers={},body}={}) {
    assert.ok(/^http:\/\/(auth:9999|rest:3000)\//.test(url));
    const input = [
      'url = '+JSON.stringify(url), 'request = '+JSON.stringify(method),
      ...Object.entries(headers).map(([key,value])=>'header = '+JSON.stringify(`${key}: ${value}`)),
      ...(body ? ['data-raw = '+JSON.stringify(body)] : []),
    ].join('\n')+'\n';
    // An internal bridge cannot publish loopback ports on all Docker backends.
    // Relay unmodified HTTP via the owned DB container, keeping secrets on stdin.
    const child = spawn('docker',['--host',host,'exec','-i',db,'curl','-q','--silent','--show-error',
      '--max-time','7','--noproxy','*','--proto','=http','--write-out','\n%{http_code}\n%{content_type}',
      '--config','-'],{env:cleanEnv,windowsHide:true,stdio:['pipe','pipe','ignore']});
    relays.add(child);
    return new Promise((resolve,reject)=>{
      const chunks=[];
      child.stdout.on('data',chunk=>chunks.push(chunk));
      child.on('error',reject);
      child.stdin.on('error',()=>{});
      child.on('close',code=>{
        relays.delete(child);
        if (code!==0) { reject(new Error('Isolated HTTP relay failed')); return; }
        const raw=Buffer.concat(chunks).toString('utf8');
        const marker=/\n(\d{3})\n([^\n]*)$/.exec(raw);
        if (!marker) { reject(new Error('Isolated HTTP response has no status')); return; }
        resolve({status:Number(marker[1]),contentType:marker[2],body:raw.slice(0,marker.index)});
      });
      child.stdin.end(input);
    });
  }
  async function start() {
    console.log(`Issue #36 Docker run UUID: ${run} (socket: ${host})`);
    network = docker(['network','create','--internal','--label',`${label}=${run}`,networkName]);
    assert.match(network,/^[a-f0-9]{64}$/);
    const [networkInfo] = JSON.parse(docker(['network','inspect',network]));
    assert.ok(networkInfo.Internal && networkInfo.Labels[label] === run && !Object.keys(networkInfo.Containers ?? {}).length);
    db = create('db', { POSTGRES_PASSWORD:dbPassword, POSTGRES_USER:'supabase_admin', POSTGRES_DB:database,
      POSTGRES_HOST:'/var/run/postgresql' },
      ['--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=384m'],
      ['postgres','-D','/etc/postgresql','-c','listen_addresses=*','-c','wal_level=logical',
        '-c','cron.database_name=postgres','-c','cron.launch_active_jobs=off']);
    docker(['start',db]);
    try {
      await waitFor(() => {
        assert.ok(inspect(db).State.Running,'Dedicated PostgreSQL exited');
        // initdb uses a temporary socket-only postmaster. Wait for the final configuration.
        return admin('SHOW listen_addresses;',true)==='*';
      },'dedicated PostgreSQL',signal,45000);
    } catch (error) {
      // A live server can still be inaccessible to the fixed local role.
      if (inspect(db).State.Running) admin('SELECT 1;');
      throw error;
    }
    const fresh = admin(`SELECT current_database(), current_setting('server_version_num'),
      to_regclass('public.rooms') IS NULL, to_regclass('public.chat_message_notifications') IS NULL;`);
    assert.match(fresh,/^postgres\|17\d{4}\|t\|t$/);
    assert.equal(admin("SHOW cron.launch_active_jobs;"),'off');
    admin(`COMMENT ON DATABASE postgres IS '${run}';
      ALTER ROLE supabase_auth_admin PASSWORD '${authPassword}';
      ALTER ROLE authenticator PASSWORD '${restPassword}';`);
    identity = admin(identityQuery);
    assert.match(identity,new RegExp('^postgres\\|[0-9]+\\|17[0-9]{4}\\|'+run+'$'));
    const auth = create('auth',{
      GOTRUE_API_HOST:'0.0.0.0', GOTRUE_API_PORT:'9999', API_EXTERNAL_URL:'http://127.0.0.1/auth/v1',
      GOTRUE_DB_DRIVER:'postgres', GOTRUE_DB_DATABASE_URL:`postgres://supabase_auth_admin:${authPassword}@db:5432/${database}?sslmode=disable`,
      GOTRUE_SITE_URL:'http://127.0.0.1', GOTRUE_DISABLE_SIGNUP:String(!allowSignup), GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',
      GOTRUE_MAILER_AUTOCONFIRM:'true', GOTRUE_JWT_SECRET:secret, GOTRUE_JWT_AUD:'authenticated',
      GOTRUE_JWT_ADMIN_ROLES:'service_role', GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated', GOTRUE_JWT_EXP:'3600',
      GOTRUE_LOG_LEVEL:'warn',
    });
    docker(['start',auth]);
    const authOrigin = 'http://auth:9999';
    const healthy = async url => relay(url).then(response=>response.status===200,()=>false);
    await waitFor(()=>healthy(authOrigin+'/health'),'real GoTrue',signal,30000);
    verifyIdentity();
    assert.equal(admin('SELECT count(*) FROM auth.users;'),'0');
    const dir = new URL('../../supabase/migrations/',import.meta.url);
    const files = readdirSync(dir);
    assert.equal(files.length,versions.length,'Review new migration list before running this test');
    assert.equal(admin("SELECT count(*) FROM pg_publication WHERE pubname='supabase_realtime';"),'1');
    for (const version of versions) {
      signal?.throwIfAborted();
      const file = files.find(name=>name.startsWith(version+'_'));
      assert.ok(file);
      try {
        admin("BEGIN; SET LOCAL ROLE postgres; SET LOCAL imahima.room_classification='[]';\n"+
          transactionBody(readFileSync(new URL(file,dir),'utf8'))+'\nCOMMIT;');
      } catch(error) { throw new Error(`Isolated migration ${version}: ${error.message}`); }
    }
    const rest = create('rest',{
      PGRST_DB_URI:`postgres://authenticator:${restPassword}@db:5432/${database}?sslmode=disable`,
      PGRST_DB_SCHEMAS:'public', PGRST_DB_ANON_ROLE:'anon', PGRST_JWT_SECRET:secret,
    });
    docker(['start',rest]);
    const restOrigin = 'http://rest:3000';
    await waitFor(()=>healthy(restOrigin+'/'),'real PostgREST',signal,30000);
    const traffic = new Map();
    gateway = createServer(async (req,res) => {
      try {
        const raw = req.url ?? '';
        const match = /^\/(auth|rest)\/v1(\/[^#]*)$/.exec(raw);
        if (!match || !/^\/[A-Za-z0-9_?./&=%-]*$/.test(match[2]) || match[2].startsWith('//')) {
          res.writeHead(404).end(); return;
        }
        const url = new URL((match[1] === 'auth' ? authOrigin : restOrigin)+match[2]);
        assert.ok([authOrigin, restOrigin].includes(url.origin));
        const headers = Object.fromEntries(['authorization','apikey','content-type','prefer','accept']
          .filter(key=>req.headers[key]).map(key=>[key,req.headers[key]]));
        const parts = [];
        for await (const chunk of req) parts.push(chunk);
        const result = await relay(url.href,{method:req.method,headers,body:parts.length?Buffer.concat(parts).toString('utf8'):undefined});
        const record = `/${match[1]}/v1${url.pathname} ${result.status}`;
        traffic.set(record,(traffic.get(record)??0)+1);
        res.writeHead(result.status,{'Content-Type':result.contentType||'application/json'}).end(result.body);
      } catch { res.writeHead(502).end(); }
    });
    await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(0,'127.0.0.1',resolve);});
    verifyIdentity();
    return { url:`http://127.0.0.1:${gateway.address().port}`, anon:key('anon'), service:key('service_role'), traffic };
  }
  async function stop() {
    for (const relay of relays) relay.kill();
    if(gateway) {
      gateway.closeAllConnections();
      await new Promise(resolve=>gateway.close(resolve));
      gateway = undefined;
    }
    const errors=[];
    const filter = `label=${label}=${run}`;
    const ids = output => output.split(/\r?\n/).filter(Boolean);
    const list = (args, description) => {
      try { return ids(docker(args)); }
      catch { errors.push(description); return []; }
    };
    // A create may have succeeded in Docker even when the CLI never returned an ID.
    for (const id of list(['ps','-aq','--no-trunc','--filter',filter], 'owned container listing failed')) {
      try {
        assert.match(id,/^[a-f0-9]{64}$/);
        const {Name}=inspect(id);
        assert.ok(['db','auth','rest'].some(kind=>Name===`/${nameOf(kind)}`));
        docker(['rm','-fv',id]);
      } catch { errors.push('owned container cleanup failed'); }
    }
    for (const id of list(['network','ls','-q','--no-trunc','--filter',filter], 'owned network listing failed')) {
      try {
        assert.match(id,/^[a-f0-9]{64}$/);
        const [meta]=JSON.parse(docker(['network','inspect',id]));
        assert.ok(meta.Id===id && meta.Name===networkName && meta.Labels[label]===run && meta.Internal);
        docker(['network','rm',id]);
      } catch { errors.push('owned network cleanup failed'); }
    }
    assert.deepEqual(errors,[]);
  }
  return {start,stop,query,verifyIdentity};
}
