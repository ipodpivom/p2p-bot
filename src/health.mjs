import { createServer } from 'node:http';

// Public monitoring endpoint: never expose orders, user IDs, configuration or credentials.
export async function startHealthServer({ port, host = '0.0.0.0', status, now = Date.now }) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    const path = (req.url ?? '').split('?')[0];
    if (!['/', '/healthz', '/readyz'].includes(path)) {
      res.writeHead(404); res.end(JSON.stringify({ status: 'not_found' })); return;
    }
    const current = status();
    // Render may overlap deployments: let it switch traffic so the previous lease holder can stop.
    const healthy = path === '/readyz' ? current.initialized : current.ready && now() - current.lastActivity < 180000;
    res.writeHead(healthy ? 200 : 503);
    res.end(JSON.stringify({ status: healthy ? 'ok' : 'starting_or_unavailable' }));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
