import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../tutorial.html', import.meta.url));
createServer((request, response) => {
  if (request.url !== '/' && request.url !== '/tutorial.html') { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src 'none'" });
  response.end(html);
}).listen(3849, '127.0.0.1', () => console.log('Tutorial at http://127.0.0.1:3849. Ctrl+C stops the local preview.'));
