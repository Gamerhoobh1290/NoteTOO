# Receive from phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LAN upload from iPhone Safari into the opened folder, originals untouched.

**Architecture:** `electron/receive.mts` (node:http, no Electron import) writes through `disk.mts`'s temp-file
writes; `main.mts` owns its lifecycle and forwards events over the preload bridge to a React dialog.

**Tech Stack:** node:http, node:crypto, Electron 44 (Node 24), React 19, vitest, `qrcode-generator` 2.0.4.

**Spec:** `docs/superpowers/specs/2026-10-15-receive-from-phone-design.md`

## Global Constraints

- No commits until the user has reviewed. No version bump.
- Key never logged; no CORS headers; no binding to 0.0.0.0 or loopback (tests pass `hosts: ['127.0.0.1']`).
- Collisions use `withSuffix` from `src/fs/paths.ts` (`name (1).ext`).
- Limits: 4 GiB/file, free space − 1 GiB, 3 concurrent uploads, 10 failures → 10 min IP lockout, headers 10 s,
  socket idle 30 s, request 2 h.

## Review Focus

- Same photo name picked twice in one batch (iOS often names files `image.jpg`) → two files, never one overwritten.
- Phone loses Wi-Fi mid-upload → no partial file, no `.crswap` left, Retry works.
- Folder switched while the server runs → server stops, nothing lands in the new folder.
- Destination folder deleted on the PC after the phone listed it → 404 with a clear message, no folder recreated.
- Key regenerated while the phone is open → next request 401 → key screen, no lockout for one stale request.

---

### Task 1: Exclusive commit in disk.mts

**Files:** Modify `electron/disk.mts` (`commitWrite`); Test `electron/disk.test.ts`

**Interfaces:** Produces `commitWrite(writeId: string, opts?: { exclusive?: boolean }): Promise<DiskResult<number>>`

- [ ] Test `exclusive commit never replaces an existing file`: begin write on existing `Maths/_notes.md`, write `x`,
  commit `{ exclusive: true }` → `{ ok:false, name:'InvalidModificationError' }`, file still `# notes`, no `.crswap`.
- [ ] Run, see it fail; implement (hard link temp→target, rm temp; `EEXIST` rethrown; other link errors →
  `existsSync` check + rename); run, pass.

### Task 2: Receiver core (TDD)

**Files:** Create `electron/receive.mts`, `electron/receive.test.ts`; Modify `electron/tsconfig.json` (include
`../src/fs/paths.ts`)

**Interfaces (produces):**
- `makeKey(): string` (12 chars Crockford), `normalizeKey(s: string): string`, `keyMatches(given: unknown, key: string): boolean`
- `class Lockout { constructor(max=10, ms=600_000, now=Date.now); blocked(ip): number /*ms left*/; fail(ip); ok(ip) }`
- `sanitizeFileName(name: string): string`
- `lanAddresses(ifaces = os.networkInterfaces()): string[]`
- `startReceiver(o: { rootId: string; hosts: string[]; port?: number; maxFileSize?: number; onFile(f: ReceivedFile): void; onError(msg: string): void }): Promise<Receiver>`
  with `Receiver { port: number; urls: string[]; key: string; newKey(): string; close(): Promise<void> }`
- `ReceivedFile { path: string; size: number; at: number }` (exported from `src/desktop/bridge.ts`)

- [ ] Tests (names = assertions): key format `/^[0-9A-HJKMNP-TV-Z]{12}$/`; `keyMatches('abcd-efgh-...')` normalised,
  wrong/short/non-string false; Lockout blocks after 10 and expires with injected clock, `ok` resets; sanitize:
  `'../../x.jpg'→'x.jpg'`, `'a\\b.png'→'b.png'`, `'CON.jpg'→'_CON.jpg'`, `'desktop.ini'→'_desktop.ini'`,
  `'a:b?.heic'→'a_b_.heic'`, `' .x. '→'x'`, `''→'file'`, 300-char name keeps `.jpg` and ≤150 chars;
  `lanAddresses` keeps 192.168/10/172.16-31, drops loopback/public/IPv6, sorts `vEthernet` last.
- [ ] Server tests on a temp folder: 401 on `/api/folders` and upload without/with wrong key; 429 after 10 wrong keys
  even with right key; bad `Host` → 421; foreign `Origin` → 403; `GET /` serves HTML with CSP; folders list excludes
  `.noteTOO` and `.git`; 12 MB upload byte-identical; second same-name upload → `IMG (1).jpg`; two parallel same-name
  uploads → two files; `dir=../x`, `dir=C:/Windows`, `dir=.noteTOO`, `dir=Nope` refused and nothing written; empty
  dir → `Inbox/` created; `maxFileSize` exceeded → 413; client aborts mid-body → no file, no `.crswap`; `newKey()`
  invalidates the old key.
- [ ] Implement until green.

### Task 3: Phone page

**Files:** Create `electron/receive-page.html`; Modify `package.json` build.files (add `electron/receive-page.html`,
`build/icon.png`)

- [ ] Follow spec "Phone page" with the mobile-native skill. Receiver reads the file once at start, hashes inline
  `<script>`/`<style>` for the CSP.
- [ ] Verify in a browser at the LAN address (mobile viewport, both color schemes).

### Task 4: Main, bridge, dialog

**Files:** Modify `electron/main.mts`, `electron/preload.cts`, `src/desktop/bridge.ts`, `src/components/TopBar.tsx`,
`src/styles.css`, `package.json` (dependency); Create `src/components/ReceiveDialog.tsx`

**Interfaces:** bridge `receiveStart(root: string): Promise<ReceiveState>`, `receiveStop(): Promise<ReceiveState>`,
`receiveState(): Promise<ReceiveState>`, `receiveNewKey(): Promise<ReceiveState>`,
`onReceiveEvent(h: (s: ReceiveState) => void): () => void`;
`ReceiveState { running: boolean; urls: string[]; key: string | null; files: ReceivedFile[]; error: string | null }`.

- [ ] main: start uses the open root id, persisted `receivePort`; stops in `openFolder` when the root changes, in
  `folder:close`, in `will-quit`.
- [ ] Dialog + top-bar button per spec; arrivals → debounced `refresh()` + toast.
- [ ] `npm run build`, `npm run desktop:compile`, `npm test` all pass.

### Task 5: Verify, review, docs

- [ ] `npm run desktop:dev`: toggle on, open the LAN URL in a second browser, upload a 10 MB+ image, compare SHA-256
  with the source, see it in the tree; toggle off → connection refused.
- [ ] security-review on `electron/receive.mts` + page; fix real findings. code-review on the diff.
- [ ] README section, `release-notes/1.2.0.md`.
