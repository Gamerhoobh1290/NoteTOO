// Paths shared by the release scripts.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const RELEASE_DIR = path.join(ROOT, 'release');
/** The private signing key: outside the repo, on the release PC only. NOTETOO_RELEASE_KEY overrides it. */
export const KEY_FILE = process.env.NOTETOO_RELEASE_KEY || path.join(homedir(), '.notetoo-release', 'release-key.pem');
export const PUBLIC_KEY_MODULE = path.join(ROOT, 'updater', 'releaseKey.mts');

export const pkg = () => JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const installerName = (version) => `NoteTOO-Setup-${version}.exe`;
export const updaterInstallerName = (version) => `NoteTOO-Updater-Setup-${version}.exe`;
export const NOTES_DIR = path.join(ROOT, 'release-notes');
