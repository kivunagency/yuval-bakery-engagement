// Tiny stand-in for the hosted Supabase API gateway: one origin, path-routed.
// Local stack only. /auth/v1/* -> Supabase Auth, /rest/v1/* -> PostgREST,
// /storage/v1/* -> Supabase Storage,
// /templates/<name>.html -> supabase/templates/ (Auth fetches its mail
// templates by URL; hosted Supabase gets the same file pasted in the dashboard).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const routes = [
  ['/auth/v1', Number(process.env.AUTH_PORT)],
  ['/rest/v1', Number(process.env.REST_PORT)],
  ['/storage/v1', Number(process.env.STORAGE_PORT)],
];

http
  .createServer(async (req, res) => {
    const tpl = /^\/templates\/([a-z_]+\.html)$/.exec(req.url ?? '');
    if (tpl && process.env.TEMPLATES_DIR) {
      try {
        const body = await readFile(join(process.env.TEMPLATES_DIR, tpl[1]));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    const hit = routes.find(([prefix]) => req.url === prefix || req.url.startsWith(prefix + '/') || req.url.startsWith(prefix + '?'));
    if (!hit) {
      res.writeHead(404).end();
      return;
    }
    const [prefix, port] = hit;
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url.slice(prefix.length) || '/', headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  })
  .listen(Number(process.env.GW_PORT), '127.0.0.1');
