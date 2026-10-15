# Receive from phone

Send full-quality photos and videos from an iPhone (Safari) into the opened school folder over the local Wi-Fi,
instead of a messenger that recompresses them. No cloud, no account, no relay. Desktop app only.

The user asked for implementation without an approval stop; decisions that would normally be asked are marked
**(decision)** and listed in the final report.

## Pieces

| Unit | Where | Job |
|---|---|---|
| Receiver | `electron/receive.mts` | LAN HTTP server: auth, lockout, Host check, routes, streaming upload into `disk.mts` |
| Phone page | `electron/receive-page.html` | Self-contained HTML/CSS/JS served by the receiver (no CDN) |
| Disk | `electron/disk.mts` | Gains an exclusive (never-overwrite) commit for the existing temp-file writes |
| Main wiring | `electron/main.mts` | IPC `receive:*`, stops the server on folder close/switch and quit, pushes events |
| Bridge | `electron/preload.cts`, `src/desktop/bridge.ts` | `receive*` calls + `onReceiveEvent` |
| Dialog | `src/components/ReceiveDialog.tsx` | Toggle, QR, address, key (show/copy/new), received list, warnings |
| Entry | `src/components/TopBar.tsx` | Phone button (highlighted while the server runs); refreshes the tree and toasts on arrivals |

## Server

- Starts only from the dialog toggle. Stops on toggle off, on folder close or switch (main's `openFolder` /
  `folder:close`), and on app quit (`will-quit` waits for interrupted uploads to remove their temp files). Starts
  and stops are serialized. The received list survives toggling off and is cleared when the folder changes.
- **Addresses:** non-internal private IPv4 (10/8, 172.16/12, 192.168/16): Wi-Fi first, virtual adapters last
  (recognised by MAC prefix, since Windows names e.g. VirtualBox's adapter "Ethernet 7"). One `http.Server` per address, all on the same port, so the user can
  pick the right one if the first guess is a virtual adapter. Nothing binds to `0.0.0.0` or loopback.
- **Port:** random free port the first time, remembered in `settings.json` and reused when free, so a Home Screen
  bookmark keeps working **(decision)**. Falls back to a new random port when taken.
- **Key:** 12 characters of Crockford base32 (60 bits, `crypto.randomInt`), shown as `XXXX-XXXX-XXXX`. New key on
  every start and on "New key". Input is normalised (case, spaces, dashes, O→0, I/L→1). Compared as SHA-256 digests
  with `timingSafeEqual`. Never logged.
- **Auth:** every `/api/*` request needs header `X-NoteTOO-Key`. Missing or wrong → 401 and counts as a failure for
  that client IP. 10 failures → that IP gets 429 for 10 minutes, even with the right key. Success clears its count.
- **Host check:** `Host` must be exactly `<bound address>:<port>` (blocks DNS rebinding). Requests with an `Origin`
  header must have the same origin. No CORS headers at all, so cross-site pages cannot read responses or send the
  custom key header.
- **Routes:**
  - `GET /` the page (no key needed; it holds no data). `GET /manifest.webmanifest`, `GET /icon.png` for the Home
    Screen. Everything else 404; wrong method 405.
  - `GET /api/folders` → `{ root, inbox: "Inbox", folders: [path…] }`: folders of the opened folder, depth ≤ 6,
    ≤ 3000 entries, skipping NoteTOO's ignored names, dot-folders and links/junctions.
  - `POST /api/upload?dir=<rel>&name=<name>` with the raw file as body (no multipart). `Content-Length` required
    (411). → `201 { path, name, size }` or `{ error }` with 400/404/409/413/429/503/507.
- **Upload:** destination `dir` ('' = `Inbox`, created when missing) is resolved with `disk.resolveIn`, must be an
  existing folder whose real path is inside the folder's real path (no junction escape), and not inside `.noteTOO`
  or a dot-folder. Name sanitised (below), made unique (`name (1).ext`, NoteTOO's existing collision rule
  **(decision)**, reserved in-process so parallel uploads never pick the same name), then streamed chunk by chunk
  (with backpressure) into `disk.beginWrite` → `writeChunk` → `commitWrite(…, { exclusive: true })`. Exclusive
  commit = hard link temp → target (fails if the target exists) then remove temp; on file systems without hard
  links, check-then-rename. Any abort/timeout/error → `abortWrite` (temp removed, no partial file).
- **Limits:** 4 GiB per file **(decision)**; refused when `Content-Length` exceeds free space minus 1 GiB
  (`statfs`); 3 uploads at a time (503 + `Retry-After`); 32 sockets max; headers within 10 s; 30 s socket
  inactivity timeout (slow-loris); 2 h per request.
- **Headers:** `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, CSP with
  `default-src 'none'`, hashed inline script/style, `connect-src 'self'`, `img-src 'self' blob:`,
  `frame-ancestors 'none'`.
- Events to the renderer (`onReceiveState`): `{ running, urls, key, files[], error? }` after each change; each received file is
  `{ path, size, at }`.

### Filename sanitising

Keep only the last path segment (split on `/` and `\`), NFC-normalise, drop invisible bidi/format characters
(`U+202E` would disguise `.exe` as `.jpg`), replace `<>:"/\|?*` and control characters
with `_`, trim spaces/dots at both ends, cap at 150 characters keeping the extension, `file` when empty. Windows
reserved names (`CON`, `NUL`, `COM1`…) and NoteTOO's reserved names (`_notes.md`, `desktop.ini`, `*.crswap`…) get a
`_` prefix. Result always passes `validateName` from `src/fs/paths.ts`. Saved files get a Mark of the Web
(`:Zone.Identifier`, ZoneId=3) on NTFS, like browser downloads. The free-space check counts uploads in progress.

## Phone page

- One HTML file, vanilla JS, no external requests. Light/dark via `prefers-color-scheme`, `viewport-fit=cover` +
  `env(safe-area-inset-*)`, 16 px inputs (no zoom), ≥ 48 px targets, no tap highlight, `apple-mobile-web-app-capable`
  + manifest for the Home Screen.
- Key from the URL fragment `#k=…` (never sent to the server or in a Referer), then removed from the address bar with
  `history.replaceState` and kept in `localStorage`. Without a key, or after a 401: key entry screen.
- Destination: native `<select>` (big iOS picker) with "Inbox (default)" then every folder as `Maths › TD › TD3`.
- File input `multiple accept="image/*,video/*"` behind a large button. Each file gets a row: thumbnail (images:
  object URL; videos: icon), name, size, progress bar (XHR upload progress), status, Retry on failure. Two uploads at
  a time. Done state: "Done: N files sent to <folder>" and "Send more".
- Original quality: a short note that in the photo picker **Options → Format → Current** keeps the original format
  (iOS 17+ "Automatic" may convert HEIC to JPEG). Verified in Apple developer forum reports, not on a device here.
  `image/heic` is deliberately not added to `accept` (Safari 17 renames files to `.heic` when it is).

## Desktop dialog

- Phone button in the top bar (desktop only); in the browser it shows a toast: only available in the desktop app.
- Dialog: on/off switch, QR (generated in the renderer with `qrcode-generator`, drawn as an SVG path, no innerHTML),
  address(es), key (hidden by default, show/copy), New key, received files this session (newest first, click to
  open), notes: same Wi-Fi, Windows may ask for firewall permission the first time (allow **Private networks**),
  plain HTTP: don't use on public Wi-Fi.
- On arrivals (debounced 800 ms): `app.refresh()` and a toast "3 files received in Maths/TD".

**Dependency (decision):** `qrcode-generator` (MIT, no dependencies, ~20 KB minified, bundled by Vite like the other
libraries). A correct QR encoder (Reed-Solomon, masking, version selection) is several hundred lines that would need
their own tests; a widely used, dependency-free library is less total risk.

## Tests (`electron/receive.test.ts`, real temp folder, real sockets on 127.0.0.1)

Key generation/matching (normalisation, wrong length, constant-time path), lockout (10 failures → 429 even with the
right key, expiry, success resets), filename sanitising, Host/Origin rejection, 401 on every API route, folder
listing (no `.noteTOO`, dot-folders, junctions), upload of 12 MB byte-identical, no overwrite (`(1)`, parallel same
name), outside-folder and `.noteTOO` destinations refused, default Inbox creation, size limit 413, aborted upload
leaves no file or temp, exclusive commit in `disk.mts`.
