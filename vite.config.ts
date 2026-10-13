/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SAMPLE_DIR = resolve(import.meta.dirname, 'sample-school');

/**
 * Dev-server only: exposes ./sample-school read-only so `?sample` can load it
 * into an in-memory folder. Never part of `npm run build`.
 */
function sampleFolder(): Plugin {
  return {
    name: 'notetoo-sample-folder',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__sample', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        if (!existsSync(SAMPLE_DIR)) {
          res.statusCode = 404;
          res.end('Run `npm run sample` first.');
          return;
        }
        if (url.pathname === '/manifest') {
          const files: { path: string; lastModified: number }[] = [];
          const dirs: string[] = [];
          const walk = (dir: string) => {
            for (const d of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, d.name);
              if (d.isDirectory()) {
                dirs.push(relative(SAMPLE_DIR, full).split(sep).join('/'));
                walk(full);
              }
              else files.push({ path: relative(SAMPLE_DIR, full).split(sep).join('/'), lastModified: statSync(full).mtimeMs });
            }
          };
          walk(SAMPLE_DIR);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ name: 'sample-school', files, dirs }));
          return;
        }
        if (url.pathname === '/file') {
          const full = resolve(SAMPLE_DIR, url.searchParams.get('path') ?? '');
          if (!full.startsWith(SAMPLE_DIR + sep) || !existsSync(full)) {
            res.statusCode = 404;
            res.end();
            return;
          }
          createReadStream(full).pipe(res);
          return;
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

const PDFJS_DIR = resolve(import.meta.dirname, 'node_modules/pdfjs-dist');
const PDFJS_ASSETS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

/**
 * Ships pdf.js font/cmap/wasm data with the app (served at ./pdfjs/…) so PDFs that rely on
 * them render offline, without any CDN.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'notetoo-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
        const full = resolve(PDFJS_DIR, rel);
        if (!PDFJS_ASSETS.some((d) => full.startsWith(join(PDFJS_DIR, d) + sep)) || !existsSync(full)) return next();
        createReadStream(full).pipe(res);
      });
    },
    generateBundle() {
      for (const d of PDFJS_ASSETS) {
        for (const name of readdirSync(join(PDFJS_DIR, d))) {
          if (name.startsWith('LICENSE')) continue;
          this.emitFile({ type: 'asset', fileName: `pdfjs/${d}/${name}`, source: readFileSync(join(PDFJS_DIR, d, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), sampleFolder(), pdfjsAssets()],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'electron/**/*.test.ts', 'updater/**/*.test.ts'] },
});
