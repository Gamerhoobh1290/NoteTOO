// Publishes the signed release to GitHub (public releases-only repo) with the gh CLI:
// tag v<version> with the installer, latest.json and latest.json.sig (plus the updater's
// installer when it was built). Everything is re-verified before upload.
// Usage: node scripts/release/publish.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { verifyManifest } from '../../updater/core.mts';
import { RELEASES_REPO } from '../../updater/feed.mts';
import { RELEASE_PUBLIC_KEY } from '../../updater/releaseKey.mts';
import { NOTES_DIR, RELEASE_DIR, ROOT, installerName, pkg, updaterInstallerName } from './paths.mjs';

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const { version } = pkg();
const at = (f) => path.join(RELEASE_DIR, f);

const m = verifyManifest(readFileSync(at('latest.json')), readFileSync(at('latest.json.sig'), 'utf8'), RELEASE_PUBLIC_KEY);
if (m.version !== version) die(`release/latest.json is for ${m.version}, package.json says ${version}. Run \`npm run release:sign\`.`);
const installer = at(installerName(version));
const digest = createHash('sha256').update(readFileSync(installer)).digest('hex');
if (digest !== m.sha256) die('The installer changed after signing. Run `npm run release:sign` again.');

const assets = [installer, at('latest.json'), at('latest.json.sig')];
const updaterVersion = JSON.parse(readFileSync(path.join(ROOT, 'updater', 'electron-builder.json'), 'utf8')).extraMetadata.version;
const updater = at(path.join('updater', updaterInstallerName(updaterVersion)));
if (existsSync(updater)) assets.push(updater);

const gh = (args) => execFileSync('gh', args, { stdio: 'inherit' });
gh(['release', 'create', `v${version}`, '--repo', RELEASES_REPO, '--title', `NoteTOO ${version}`, '--notes-file', path.join(NOTES_DIR, `${version}.md`), '--latest', ...assets]);
console.log(`Published NoteTOO ${version} to https://github.com/${RELEASES_REPO}/releases/tag/v${version}`);
