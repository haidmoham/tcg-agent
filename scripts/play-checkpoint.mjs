import { createServer } from 'node:http';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlaySession, decks } from '../play/session.mjs';

const root = fileURLToPath(new URL('../play/', import.meta.url));
const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function createPlayServer(config) {
  const session = new PlaySession(config);
  const fixed = new Map([
    ['/', join(root, 'index.html')], ['/app.mjs', join(root, 'app.mjs')], ['/prompt-answer.mjs', join(root, 'prompt-answer.mjs')], ['/style.css', join(root, 'style.css')],
    ['/indigo/board.css', join(config.indigoRoot, 'apps/live/src/board.css')],
    ['/indigo/battle-lab.css', join(config.indigoRoot, 'apps/live/src/battle-lab.css')],
    ['/art/cardback.png', join(config.indigoRoot, 'ptcg-server/assets/cardback.png')],
    ['/art/board.svg', join(config.indigoRoot, 'ptcg-play-react/public/assets/indigo-live-board-center.svg')],
  ]);
  const artRoot = realpathSync(config.cardArtRoot ?? join(config.indigoRoot, 'apps/live/public/card-textures'));
  const server = createServer(async (req, res) => {
    const port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, { error: 'Open the exact loopback URL printed by the server.' });
      const path = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && path === '/api/catalog') return send(200, { models: session.models, decks });
      if (req.method === 'GET' && path === '/api/state') return send(200, await session.serialized(() => session.state()));
      if (req.method === 'POST' && /^\/api\/(new|command|preview|assist)$/.test(path)) {
        if ((req.headers.origin && req.headers.origin !== origin) || req.headers['content-type'] !== 'application/json' || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Use the local interface to submit JSON commands.' });
        let size = 0; const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 65536) return send(413, { error: 'Command exceeds local request budget.' });
          chunks.push(chunk);
        }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks)); } catch { return send(400, { error: 'Invalid JSON.' }); }
        return send(200, await session.mutate(path.slice(5), body));
      }
      if (req.method !== 'GET') return send(404, { error: 'Unknown local route.' });
      let file = fixed.get(path);
      const art = /^\/art\/([A-Z0-9]+)-(\d{1,3})\.png$/.exec(path);
      if (!file && art) {
        const filename = `${art[1]}-${art[2].padStart(3, '0')}.png`;
        file = join(artRoot, filename);
        if (existsSync(file)) {
          const target = realpathSync(file), inside = relative(artRoot, target);
          if (inside.startsWith('..') || isAbsolute(inside)) return send(404, { error: 'Unknown asset.' });
        }
      }
      if (!file || !existsSync(file)) return send(404, { error: 'Local asset unavailable.' });
      const extension = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': `${mime[extension] ?? 'application/octet-stream'}${['.mjs', '.css', '.html', '.svg'].includes(extension) ? '; charset=utf-8' : ''}` });
      res.end(readFileSync(file));
    } catch (error) {
      if (!res.headersSent) send(error.status ?? 500, { error: error.status ? error.message : 'Local runtime could not complete this request. Start a new game or inspect the terminal.' });
      else res.end();
      if (!error.status) console.error(error.message);
    }
  });
  return { server, session };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node scripts/play-checkpoint.mjs <private-play-config.json> [port]');
  const port = Number(process.argv[3] ?? 3851);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port from 1024 through 65535.');
  const { server, session } = createPlayServer(JSON.parse(readFileSync(configPath, 'utf8')));
  server.listen(port, '127.0.0.1', () => console.log(`Checkpoint play ready at http://127.0.0.1:${port} (this computer only).`));
  const stop = async () => { server.closeAllConnections(); server.close(); await session.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
