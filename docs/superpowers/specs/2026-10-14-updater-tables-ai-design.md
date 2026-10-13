# NoteTOO 1.1: Updater, Scratchpad tables, document-aware AI

Approved choices: 1A (separate Electron updater), 2A (block editor, GFM tables), 3A (structured model +
lexical retrieval + validated highlighting). Releases: public releases-only repo `Gamerhoobh1290/notetoo-releases`.

## 1. Release pipeline and NoteTOO Updater

**Feed** (in every GitHub release, so `releases/latest/download/…` always points at the newest):

- `latest.json`: `{ "app": "NoteTOO", "version": "1.1.0", "releasedAt": ISO, "notes": "…",
  "url": "https://github.com/…/releases/download/v1.1.0/NoteTOO-Setup-1.1.0.exe", "size": n, "sha256": hex }`
- `latest.json.sig`: base64 Ed25519 signature over the exact bytes of `latest.json`.

The signing key is generated once by `scripts/release/keygen.mjs` into `%USERPROFILE%\.notetoo-release\` (never in
the repo); the public key is committed at `updater/release-key.pub.pem` and compiled into the updater.

**Workflow** (`docs/RELEASING.md`): bump `version` → `npm run dist:win` → `npm run release:sign` (writes
`release/latest.json` + `.sig`) → `npm run release:publish` (`gh release create`).

**Updater** (`updater/`, built from the root package with its own Vite + electron-builder config):

- Finds NoteTOO through the per-user (then per-machine) uninstall registry entry written by the NSIS installer:
  `DisplayVersion`, `InstallLocation`; confirms `NoteTOO.exe` exists there.
- Check: fetch `latest.json` and `.sig` (timeout, offline → clear message), verify signature before parsing,
  validate fields, compare semver.
- Download to `%TEMP%\NoteTOO Updater\` as `.partial` with progress; resumes with a Range request after an
  interruption; verifies size and SHA-256, deletes the file on mismatch.
- Install: if NoteTOO runs, ask, then close it gracefully (`taskkill` without `/F` → NoteTOO's own save-on-close);
  never force-kill. Run the installer `/S /D=<install folder>`, then confirm the registry shows the new version.
  Offer "Open NoteTOO".
- Only runs while open: no tray, service, or scheduled task. User data (`%APPDATA%\NoteTOO`, the school folder)
  is never touched by the installer (`deleteAppDataOnUninstall: false`).
- `NOTETOO_UPDATE_FEED` env var overrides the feed URL for testing; signature verification still applies.

## 2. Scratchpad tables

- `src/notes/blocks.ts` (pure, tested): Markdown ⇄ blocks. A table block is a GFM table, optionally preceded by
  `<!-- notetoo-table widths=120,200 -->`. Cells escape `|` as `\|` and newlines as `<br>`. Text outside tables
  round-trips byte-for-byte.
- Write mode renders blocks: text blocks are auto-growing textareas (toolbar acts on the focused one); table blocks
  are an inline grid (cell inputs, add/delete row/column, drag column borders to resize, delete table).
- Toolbar "Insert table" opens a rows × columns picker; inserts at the caret.
- Preview unchanged (remark-gfm). Subject notes get the same editor.

## 3. NoteTOOAI

- `src/ai/structure.ts`: `AiDoc` text → `DocModel { type guess, sections[{ id, title, level, page, blocks }],
  blocks[{ id, kind: heading|paragraph|list|table|caption, page, text, start, end, sectionPath }] }`. PDF headings from
  font size / boldness relative to body text (extract.ts records font height per span); docx via mammoth HTML;
  Markdown via `#`; sheets as tables.
- `src/ai/retrieve.ts`: BM25 over blocks (accent-insensitive, FR/EN stopwords) with section expansion and a
  character budget; returns passages with page + section labels.
- Profile: one cached call per document version → `{ type, purpose, outline, keyConcepts }`. In-memory LRU cache
  (8 docs) keyed by path + modified time + size; a changed file gets a new key.
- Workflow context sent with requests: intent (study / review / find / compare / organize / highlight), selected text,
  current file, recently opened files (names + profiles), relevant previous turns.
- Document references: a question naming a file ("le TD3", "the document I opened earlier") is resolved against
  recent files and the file index; ambiguous → ask; unreadable → say so.
- Answers cite `[p. N]` / section, separate "the document says" from inferences, and say when the document does
  not support a conclusion. Document text is wrapped and declared as data, never instructions.
- Highlights: model receives sections with block IDs and the profile, returns `{ block, quote, category, importance
  1–5, why }`. Code keeps a candidate only if the quote matches fully inside that block, importance ≥ 3, it does not
  overlap an existing highlight or another candidate, and it fits a budget (~1 per page, max 12, scaled by intent).
  Rects are one per line (`rects` optional in sidecar; `rect` stays the bounding box for 1.0 compatibility).
  Suggestions stay reviewable (keep / discard / keep all) as today.

## Verification

Unit tests for blocks, structure, retrieval, highlight validation, manifest/signature, version compare. Real-model
runs (Ollama qwen3.5:9b) on sample documents of different types, judged on relevance, precision and placement.
End to end: install 1.0.0, publish 1.1.0, update through the Updater, verify tables, AI, and that notes,
annotations and settings survive.
