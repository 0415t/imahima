// Dedicated local verification gateway. No external upstreams or request logging.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string'
  && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const server = http.createServer((req, res) => {
  if (!equal(req.headers.apikey, process.env.ANON_KEY)
      && !equal(req.headers.apikey, process.env.SERVICE_ROLE_KEY)) {
    res.writeHead(401).end(); return;
  }
  const auth = req.url.startsWith('/auth/v1/');
  const rest = req.url.startsWith('/rest/v1/');
  if (!auth && !rest) { res.writeHead(404).end(); return; }
  const upstream = http.request({
    hostname: auth ? 'imahima-member-free-api-auth' : 'imahima-member-free-api-rest',
    port: auth ? 9999 : 3000, method: req.method,
    path: req.url.slice(auth ? '/auth/v1'.length : '/rest/v1'.length),
    headers: { ...req.headers, host: auth ? 'imahima-member-free-api-auth:9999' : 'imahima-member-free-api-rest:3000' },
    timeout: 10000,
  }, (response) => {
    res.writeHead(response.statusCode, response.headers);
    response.on('close', () => { if (!response.complete) res.destroy(); });
    response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
server.listen(8000, '0.0.0.0');
