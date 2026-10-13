// `npm run desktop:dev`: Vite dev server (hot reload) + the Electron window pointed at it.
// Extra arguments are passed to Electron (e.g. a folder path to open).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5174, strictPort: true } });
await server.listen();
const url = server.resolvedUrls.local[0];

const electron = createRequire(import.meta.url)('electron'); // path of the Electron binary
const child = spawn(electron, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, NOTETOO_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
