import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { openReview, type ReviewOptions } from './review-session.ts';

async function readRequest(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1024 * 1024 + 1024) throw new Error('Profile limit is 1 MiB.');
    parts.push(bytes);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function startReview(options: ReviewOptions, port = 0) {
  const session = await openReview(options);
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ]);
  let origin = '';
  let busy = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    const route = req.url ?? '';
    let locked = false;
    try {
      const asset = assets.get(route);
      if (req.method === 'GET' && asset) {
        const bytes = await readFile(new URL('../ui/review/' + asset[0], import.meta.url));
        res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }).end(bytes); return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (req.method === 'GET' && route === '/api/session') { res.end(JSON.stringify(session.state())); return; }
      if (req.method !== 'POST' || !/^\/api\/(draft|preview|generate|acknowledge|prepare)$/.test(route)) {
        res.writeHead(404).end(); return;
      }
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') {
        res.writeHead(403).end(); return;
      }
      if (busy) { res.writeHead(409).end(JSON.stringify({ error: 'A review operation is in progress.' })); return; }
      busy = true; locked = true;
      const result = await session.execute(route.slice(5), await readRequest(req));
      res.end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Review operation failed.';
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: message }));
    } finally { if (locked) busy = false; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not listen on loopback.');
  origin = 'http://127.0.0.1:' + address.port;
  return { server, origin };
}
