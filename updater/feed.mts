// Where official NoteTOO releases are published (shared by the updater and scripts/release/).

export const RELEASES_REPO = 'Gamerhoobh1290/notetoo-releases';
export const RELEASES_PAGE = `https://github.com/${RELEASES_REPO}/releases`;
/** Always the newest release's manifest; `latest.json.sig` sits next to it. */
export const FEED_URL = `${RELEASES_PAGE}/latest/download/latest.json`;
export const installerUrl = (version: string, file: string) => `${RELEASES_PAGE}/download/v${version}/${file}`;
