// `NoteTOO-Server.cmd` / `npm run server`: runs the NoteTOO server on this PC, so a browser on
// another computer (a laptop at home, or anywhere through Tailscale) uses NoteTOO with the files,
// notes and AI of this PC. Also manages what it shares: see `--help`.

import * as http from 'node:http';
import { networkInterfaces } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { isDirectory } from '../electron/disk.mjs';
import { lanAddresses } from '../electron/receive.mjs';
import { createNoteTooServer } from './app.mjs';
import { ConfigStore, newCredentials, samePath } from './config.mjs';
import { moveToRecycleBin } from './recycle.mjs';

const HELP = `NoteTOO server: use NoteTOO from a browser on another computer; files, notes and AI stay on this PC.

  NoteTOO-Server.cmd                       start the server
  NoteTOO-Server.cmd --add-folder <path>   share a folder (your school folder)
  NoteTOO-Server.cmd --remove-folder <p>   stop sharing a folder
  NoteTOO-Server.cmd --list                show the shared folders, the port and the access key
  NoteTOO-Server.cmd --new-key             new access key (signs every browser out)

  --port <n>      port to use (default 8787; remembered)
  --host <addr>   address to listen on (default 0.0.0.0: this PC's network and Tailscale addresses;
                  127.0.0.1 = only through "tailscale serve" or on this PC)

Settings: %APPDATA%\\NoteTOO\\server.json`;

const HERE = import.meta.dirname; // out/server/
const APP_DIR = path.join(HERE, '..', '..');

const { values: args } = parseArgs({
  options: {
    'add-folder': { type: 'string', multiple: true },
    'remove-folder': { type: 'string', multiple: true },
    list: { type: 'boolean' },
    'new-key': { type: 'boolean' },
    port: { type: 'string' },
    host: { type: 'string', default: '0.0.0.0' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const dataDir = process.env.NOTETOO_DATA_DIR ?? path.join(process.env.APPDATA ?? path.join(process.env.HOME ?? '.', '.config'), 'NoteTOO');
const store = new ConfigStore(dataDir);
const formatKey = (k: string) => k.match(/.{1,4}/g)!.join('-');

function printSetup() {
  const c = store.get();
  console.log(`Shared folders (${c.folders.length}):`);
  for (const f of c.folders) console.log(`  ${f}`);
  if (!c.folders.length) console.log('  none yet: NoteTOO-Server.cmd --add-folder "D:\\path\\to\\your\\school folder"');
  console.log(`Port:       ${c.port}`);
  console.log(`Access key: ${formatKey(c.key)}`);
}

let manage = false;
for (const f of args['add-folder'] ?? []) {
  manage = true;
  const full = path.resolve(f);
  if (!isDirectory(full)) {
    console.error(`Not a folder: ${full}`);
    process.exit(1);
  }
  store.update((c) => void (c.folders.some((p) => samePath(p, full)) || c.folders.push(full)));
  console.log(`Sharing ${full}`);
}
for (const f of args['remove-folder'] ?? []) {
  manage = true;
  store.update((c) => void (c.folders = c.folders.filter((p) => !samePath(p, f))));
  console.log(`No longer sharing ${path.resolve(f)}`);
}
if (args['new-key']) {
  manage = true;
  store.update((c) => Object.assign(c, newCredentials()));
  console.log('New access key. Every browser has to sign in again.');
}
if (args.port) {
  const port = Number(args.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${args.port}`);
    process.exit(1);
  }
  store.update((c) => void (c.port = port));
}
if (manage || args.list) {
  printSetup();
  process.exit(0);
}

// ---------- run ----------

const app = createNoteTooServer({ store, distDir: path.join(APP_DIR, 'dist'), trash: moveToRecycleBin });
const server = http.createServer({ headersTimeout: 30_000, requestTimeout: 10 * 60_000, keepAliveTimeout: 10_000 }, app.handler);
server.maxConnections = 128;
const { port } = store.get();
const host = args.host!;

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(
    e.code === 'EADDRINUSE'
      ? `Port ${port} is already in use (is the NoteTOO server already running?). Pick another one with --port.`
      : `Could not start: ${e.message}`,
  );
  process.exit(1);
});

server.listen(port, host, () => {
  const tailscale = Object.entries(networkInterfaces())
    .flatMap(([, list]) => list ?? [])
    .filter((i) => i.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address))
    .map((i) => i.address);
  const local = host === '0.0.0.0' || host === '::';
  console.log('NoteTOO server is running. Keep this window open (closing it stops NoteTOO for other computers).\n');
  console.log(`  On this PC:           http://localhost:${port}`);
  if (local) {
    for (const a of lanAddresses()) console.log(`  Same Wi-Fi / network: http://${a}:${port}`);
    for (const a of tailscale) console.log(`  Tailscale (anywhere): http://${a}:${port}`);
    if (!tailscale.length) console.log('  Tailscale:            not connected (see README: "Remote access")');
  } else {
    console.log(`  Listening on ${host} only.`);
  }
  console.log('');
  printSetup();
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping…');
  server.close();
  server.closeAllConnections();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
