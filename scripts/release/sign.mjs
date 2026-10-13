// Writes release/latest.json (version, notes, installer URL, size, SHA-256) and
// release/latest.json.sig (Ed25519 signature over its exact bytes), then checks both with the
// updater's own verification code. Run after `npm run dist:win`.
// Release notes come from release-notes/<version>.md.
// Usage: node scripts/release/sign.mjs
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { compareVersions, verifyManifest } from '../../updater/core.mts';
import { installerUrl } from '../../updater/feed.mts';
import { RELEASE_PUBLIC_KEY } from '../../updater/releaseKey.mts';
import { KEY_FILE, NOTES_DIR, RELEASE_DIR, installerName, pkg } from './paths.mjs';

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

const { version } = pkg();
compareVersions(version, '0.0.0'); // throws on anything but x.y.z
const file = installerName(version);
const installer = path.join(RELEASE_DIR, file);
if (!existsSync(installer)) die(`${installer} not found. Run \`npm run dist:win\` first.`);
const notesFile = path.join(NOTES_DIR, `${version}.md`);
if (!existsSync(notesFile)) die(`Write the release notes in ${notesFile} first (shown in the updater).`);
if (!existsSync(KEY_FILE)) die(`No signing key at ${KEY_FILE}. Run \`node scripts/release/keygen.mjs\` once (or set NOTETOO_RELEASE_KEY).`);

const hash = createHash('sha256');
for await (const chunk of createReadStream(installer)) hash.update(chunk);

const manifest = {
  app: 'NoteTOO',
  version,
  releasedAt: new Date().toISOString(),
  notes: readFileSync(notesFile, 'utf8').trim(),
  url: installerUrl(version, file),
  size: statSync(installer).size,
  sha256: hash.digest('hex'),
};
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const signature = sign(null, bytes, createPrivateKey(readFileSync(KEY_FILE))).toString('base64');

// The same check every updater runs: catches a key that does not match updater/releaseKey.mts.
try {
  verifyManifest(bytes, signature, RELEASE_PUBLIC_KEY);
} catch (e) {
  die(`Self-check failed: ${e.message}\nThe private key does not match updater/releaseKey.mts.`);
}
writeFileSync(path.join(RELEASE_DIR, 'latest.json'), bytes);
writeFileSync(path.join(RELEASE_DIR, 'latest.json.sig'), signature + '\n');
console.log(`Signed NoteTOO ${version}: ${file}, ${manifest.size} bytes, sha256 ${manifest.sha256}`);
