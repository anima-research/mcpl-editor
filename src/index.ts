/**
 * mcpl-editor — Hosted collaborative markdown editor as MCPL server.
 *
 * Usage:
 *   node --import tsx src/index.ts --port 3000 --store ./data/editor
 *   node --import tsx src/index.ts --port 3000 --store ./data/editor --seed "# Hello\n\nStart writing."
 */

import { EditorServer } from './server.js';

const args = process.argv.slice(2);

function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return fallback;
  return args[idx + 1]!;
}

const port = parseInt(process.env.PORT ?? getArg('port', '3100'), 10);
const storePath = process.env.STORE_PATH ?? getArg('store', './data/editor-store');
const seed = getArg('seed', '');

const server = new EditorServer({
  port,
  storePath,
  initialText: seed || undefined,
});

server.start(port).catch((err) => {
  console.error('Failed to start mcpl-editor:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
