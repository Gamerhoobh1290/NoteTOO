// `npm run updater:dev`: the updater's page on a Vite dev server (hot reload) inside its Electron window.
// Set NOTETOO_UPDATE_FEED to try a test feed (it must still be signed with the release key).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const server = await createServer({ configFile: 'updater/vite.config.ts', server: { port: 5175, strictPort: true } });
await server.listen();
const url = server.resolvedUrls.local[0];

const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['out/updater/main.mjs'], { stdio: 'inherit', env: { ...process.env, NOTETOO_UPDATER_DEV_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
