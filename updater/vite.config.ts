// The updater's page: a separate small Vite build (dist-updater/), sharing NoteTOO's tokens and fonts.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/** Strict CSP in the built page (dev keeps Vite's inline refresh script working). */
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; frame-src 'none'";
function csp(): Plugin {
  return {
    name: 'updater-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname),
  base: './',
  // build/icon.png is the window and title bar icon
  publicDir: resolve(import.meta.dirname, '..', 'build'),
  plugins: [react(), csp()],
  build: { outDir: resolve(import.meta.dirname, '..', 'dist-updater'), emptyOutDir: true },
});
