import fs from 'node:fs';
import { createPlayServer } from './play-checkpoint.mjs';
import { HumanSession, humanDecks } from '../play/human-session.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2] ?? 'runs/human-local/config.json', 'utf8'));
const port = Number(process.argv[3] ?? 3860);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid localhost port');
const { server, session } = createPlayServer(config, { Session: HumanSession, deckCatalog: humanDecks });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/`,
  records: config.recordsRoot, checkpoint: config.checkpointSha256, device: 'cpu' })));
server.on('error', async error => { console.error(error.message); await session.close(); process.exitCode = 1; });
const stop = async () => { server.closeAllConnections(); server.close(); await session.close(); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
