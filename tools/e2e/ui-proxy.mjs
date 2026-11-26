// Serve the built dashboard (central/dist/client) and proxy /api (HTTP + WebSocket) to the local Worker.
//   node tools/e2e/ui-proxy.mjs [port] [backend]
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.argv[2] || 8933);
const backend = new URL(process.argv[3] || 'http://127.0.0.1:8787');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../central/dist/client');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const p = http.request({ host: backend.hostname, port: backend.port, method: req.method, path: req.url, headers: { ...req.headers, host: backend.host } }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    p.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    req.pipe(p);
    return;
  }
  let f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(backend.port), backend.hostname, () => {
    const headers = Object.entries({ ...req.headers, host: backend.host }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`ui proxy on http://127.0.0.1:${port} -> ${backend.href}`));
