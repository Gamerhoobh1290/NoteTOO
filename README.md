# NoteTOO

A local app to organize, preview and annotate your school files, as a [Windows desktop app](#windows-desktop-app) or in
Chrome/Edge. Everything it creates is saved as normal files in
**your own folder**; there is no backend and no account. If your folder is synced by OneDrive or Google Drive Desktop, your
notes and annotations are synced with it. An optional [AI assistant](#ai-assistant) can summarize, explain and highlight
your files, guide you through the app, and propose how to organize your folder, using a model on your own PC (Ollama) or a
provider you choose.

## Requirements

- **Google Chrome or Microsoft Edge** (desktop), recent version. NoteTOO uses the File System Access API, which other
  browsers do not support; they get a clear message instead.
- Node.js 20+ to build and run it.

## Run it

```bash
npm install
npm run dev        # development server: http://localhost:5173
```

Or build the static version and serve it:

```bash
npm run build      # outputs ./dist (static files, works offline)
npm run preview    # serves ./dist at http://localhost:4173
```

`dist/` can be served by any static file server on `localhost` or HTTPS. Opening `dist/index.html` directly as a `file://`
page does not work, because browsers block module scripts there.

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | Unit tests (path mirroring, sidecar read/write, file operations on an in-memory folder, AI answer validation and organize planning), plus the desktop disk backend on a real temporary folder |
| `npm run sample` | Generates `./sample-school/`, a throwaway test folder (`-- --force` regenerates it) |

## Windows desktop app

The same app, packaged with Electron as a native Windows 11 program.

```bash
npm run desktop:dev   # development: Vite with hot reload inside the desktop window
npm run desktop       # build, then run the production build in the desktop window
npm run dist:win      # installer: release/NoteTOO-Setup-<version>.exe (and release/win-unpacked/NoteTOO.exe)
```

The installer is per-user (no admin rights), lets you choose the install folder, and adds Start menu and desktop
shortcuts. It is **not code-signed**, so the first time Windows SmartScreen shows "Windows protected your PC"
(*More info → Run anyway*). Signing needs a code-signing certificate, which electron-builder reads from `CSC_LINK` /
`CSC_KEY_PASSWORD`. `python scripts/make-icon.py` regenerates the icon in `build/`.

What is different from the browser version:

- **Window**: native Windows 11 minimize / maximize / close buttons (with Snap Layouts) in NoteTOO's own top bar.
  Drag the top bar to move the window, double-click it to maximize. Size, position and maximized state come back on
  the next start. Only one NoteTOO window runs; starting it again focuses the existing one.
- **Your folder reopens automatically** at every start. Click the folder name in the top bar to switch to a recent
  folder, open another (`Ctrl+O`), open it in File Explorer, or close it (the next start then shows the start screen
  with your recent folders). Right-click NoteTOO in the taskbar to open a recent folder directly.
- **Delete moves to the Recycle Bin**, so a deleted file or folder (with its annotations) can be restored from Windows.
- **Open with default app** and **Show in File Explorer** in every file's menu and on the "no preview" card.
- **Audio and video stream from disk**, with seeking, instead of being read into memory.
- **Theme**: System, Light or Dark (button at the top right).
- **Closing the window saves first**: pending note and annotation edits are written before NoteTOO exits. If one
  cannot be saved (e.g. the file is read-only), NoteTOO stays open and says so.
- Rename and move are real file-system moves (files keep their modified date). Writes still go through a temporary
  file that replaces the original only when complete.
- Extra shortcuts: `Ctrl+O` open folder, `F5` re-scan, `Ctrl+=` / `Ctrl+−` / `Ctrl+0` zoom, `F11` full screen.
- Right-click in text fields for cut / copy / paste and spelling suggestions.

**Where the desktop app keeps its own settings:** `%APPDATA%\NoteTOO\settings.json` (window size, recent folders, last
folder, theme). The AI settings live in the app's local storage in the same `%APPDATA%\NoteTOO` folder. Your notes and
annotations stay in your school folder exactly as in the browser version. Uninstalling keeps `%APPDATA%\NoteTOO`;
delete it to reset the app.

**Security:** the page has no Node.js access. It asks the main process (`electron/`) for disk operations by (opened
folder, relative path), and the main process refuses any path outside the folder you opened. Links in notes and AI
answers open in your default browser.

## Pick your folder

1. Click **Open my school folder** and choose the root folder (e.g. `OneDrive\École`).
2. Chrome asks for permission to **view and edit** the folder. Accept it; without edit access nothing can be saved.
3. Each first-level folder in it is shown as a **subject**.

NoteTOO asks for the folder **every time it starts**. Remembering it would require storing the folder handle in the
browser's IndexedDB, which this app deliberately does not do. The trade-off: if re-picking gets annoying, the handle could
be kept in IndexedDB (only the handle, no data) and Chrome would offer "Allow on every visit". That is a one-line opt-in to
discuss, not something the app does on its own.

**Developers only:** with `npm run dev`, opening `http://localhost:5173/?sample` loads `./sample-school` into an
**in-memory** copy. Changes there are never written to disk, and this mode does not exist in `npm run build`.

## How data is stored on disk

```
<Root>/
  <Subject>/
    Cours/  TD/  TP/  Exams/  Other/     <- created when you create a subject in the app
    _notes.md                            <- the subject's notes (Notes button on the subject page)
  _scratchpad.md                         <- the global scratchpad (top bar)
  .noteTOO/                              <- annotations, mirroring your files' paths
    Maths/TD/TD3/ex2.pdf.annotations.json
```

- **Your files are never modified.** Highlights, pins and comments go to the sidecar JSON in `.noteTOO/`, at the same
  relative path as the file plus `.annotations.json`. Two files with the same name in different folders therefore never
  share annotations.
- **Rename, move and delete** happen only through explicit in-app actions. Delete always asks for confirmation and names
  the item. When a file or folder is renamed or moved in the app, its sidecar(s) move with it; when it is deleted, its
  sidecar is deleted too.
- **Adding files** (drag and drop from your PC onto a section or folder, or "Add files…") copies them. Name collisions
  never overwrite anything: the copy is saved as `name (1).ext`.
- **Folders you already have** are adopted as they are. Section folders are matched case-insensitively (`cours` counts
  as Cours). Other folders and loose files in a subject are shown under **Other**; nothing is moved or created until you
  act.
- **Saving** is automatic, about 0.7 s after a change, with a *Saving… / Saved* indicator. The browser writes a temporary
  file and replaces the target only when the write completes, so a failed write never leaves a half-written file.
  Failures show an error with **Retry**.
- **Changes from sync or other devices:** before every write NoteTOO checks the file's modified time. If the file changed
  on disk since it was loaded, you choose **Reload from disk** or **Overwrite with my version**. If you had already left
  the note when the conflict was found, your text is saved next to it as `name (unsaved <date>).md` instead of being lost.
  Notes and annotations with no pending edits reload automatically when you come back to the window.
- **Damaged annotation files** are kept as `*.annotations.broken.json` and a fresh one is started; the app never crashes
  on them.
- Sidecar format:

  ```json
  {
    "version": 1,
    "file": "Maths/TD/TD3/ex2.pdf",
    "fileComments": [{ "id": "…", "text": "…", "createdAt": "ISO-8601" }],
    "annotations": [
      { "id": "…", "type": "area", "page": 2, "rect": { "x": 0.12, "y": 0.3, "w": 0.4, "h": 0.08 },
        "color": "yellow", "comment": "Check this formula", "createdAt": "…", "updatedAt": "…" },
      { "id": "…", "type": "pin", "page": 1, "point": { "x": 0.5, "y": 0.2 },
        "color": "blue", "comment": "…", "createdAt": "…", "updatedAt": "…" }
    ]
  }
  ```

  Coordinates are fractions (0–1) of the page or image, so they stay aligned at any zoom. Images use `page: 1`.

Ignored in file lists: `.noteTOO/`, `_notes.md`, `_scratchpad.md`, `desktop.ini`, `.DS_Store`, `Thumbs.db`, and Chrome's
temporary `*.crswap` files.

## Features at a glance

- Sidebar with subjects → Cours / TD / TP / Exams / Other → subfolders → files. Right-click or use the `…` button for
  actions.
- **Drag and drop everywhere.** Any file row can be dragged: sidebar, search results, the subject page's lists, and the
  open file's title. Any folder you can see is a drop target: section tiles, the subfolders listed on them, and every
  folder in the sidebar. While dragging, valid targets get a dashed outline, the one under the pointer says
  "Move to …" or "Already here", and a closed sidebar folder springs open after a short hover. Files dragged in from your
  PC are copied ("Copy to …"); dropped elsewhere on a subject page, they land in its **To sort** tray. Every move shows
  a toast with **Undo**.
- **To sort tray**: loose files (directly in the subject folder or in Other) with one-click Cours / TD / TP / Exams buttons.
- **Multi-select**: Ctrl-click or Shift-click file rows, then drag any of them, or use the selection bar (Move to… /
  Delete…). Esc clears the selection.
- Search by file name (accent-insensitive) across everything, with subject and section filters. Sort by name, modified
  date or type.
- Subject overview: file counts per section and the most recently modified files (from the files' dates on disk).
- Previews: PDF (continuous scroll, lazy page rendering, zoom, fit-to-width, page navigation, text selection, search),
  images (zoom and pan), docx (simplified, read-only), xlsx/xls/ods/csv (one tab per sheet), video and audio (speed
  control), markdown (formatted or raw), text, and syntax-highlighted code with line numbers.
- Annotations on PDFs and images: area highlights (yellow, green, pink, blue) and comment pins. The side panel lists them;
  click one to jump to it, and edit its comment or color or delete it there. Every file type can have file-level comments.
- Notes: per-subject `_notes.md` and a global `_scratchpad.md` in a slide-over panel, with a Markdown toolbar and
  Write / Split / Preview modes.
- Light and dark themes follow the operating system.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` or `/` | Search files |
| `Alt+1` / `Alt+2` / `Alt+3` / `Alt+4` | Toggle sidebar / annotations panel / scratchpad / AI assistant |
| `←` `→` or `P` `N` | Previous / next PDF page |
| `+` / `−` | Zoom in / out (PDF, image) |
| `Ctrl+F` | Search inside the open PDF |
| `V` / `H` / `C` | Select, highlight-area, comment-pin tool |
| `Ctrl+B` / `Ctrl+I` | Bold / italic in the note editor |
| `Ctrl`/`Shift`+click | Select several files |
| `Esc` | Clear the selection |
| `?` | Show all shortcuts |

## AI assistant

Open it with the **✨ AI** button in the top bar (`Alt+4`). It works with what is open:

| Where you are | What it can do |
|---|---|
| A file | **Summarize**, **Explain**, **Highlight important**. Select text in a PDF, document, note or code file and click **Explain** to explain just that passage. |
| A subject page | **Organize this subject** |
| Home | **Organize everything** |
| Anywhere | Ask questions about the open file, or about how to use NoteTOO. Answers about the app include **Show me** buttons that open the right place and outline the control. |

- **Highlights** on PDFs with text appear as dashed purple boxes. Keep or discard each one (or all) in the annotations
  panel; kept ones become normal purple highlights saved in `.noteTOO`, with the AI's reason as their comment. Other text
  files get a clickable list of key points instead. Images and scanned PDFs can be summarized and explained (with a vision
  model) but not highlighted.
- **Organize** reads the beginning of each file (and describes images, with a vision model), then proposes moves, renames
  and new folders. You get a checklist: uncheck or edit any destination, then **Apply**. Every change moves the file's
  annotations with it, and **Undo all** puts everything back. Nothing is changed before you apply. Files' extensions never
  change, and destinations must be `Subject/Section/…/file`. Up to 400 files are reviewed per run.
- **Save to notes** on any answer appends it, with a dated heading, to the subject's `_notes.md` (or the scratchpad).
- Answers are in the language of the document (or of your question). The conversation is kept in memory only.

### Setting it up

Click the status chip at the top of the AI panel (**Not set up**):

- **Ollama (this PC)**: free and private, nothing leaves your computer. Install [Ollama](https://ollama.com), then pull a
  model, e.g. `ollama pull qwen3.5:9b` (reads text and images; fine on a 12 GB GPU). NoteTOO lists the installed models.
  Lower the context size on smaller PCs.
- **OpenRouter** or any **OpenAI-compatible** server (LM Studio, Groq, …): enter the URL and an API key. With these, the
  content of the files you use the AI on is sent to that provider; the settings dialog says so. Set a credit limit on the
  key; free models (`:free`) are rate-limited.

**Test connection** checks the setup. The vision model is optional and only used for images and scanned PDFs.

**Where the settings live:** in this browser's local storage, under `notetoo.ai.v1`. This is the one deliberate exception
to "nothing in the browser": each PC keeps its own setup (e.g. Ollama on a desktop, OpenRouter on a laptop), and an API
key must never be written into your synced school folder. Clearing browser data only means entering the settings again;
none of your files or notes are affected.

Ollama accepts requests from `localhost` pages by default. If you serve NoteTOO from another address, add it to
Ollama's `OLLAMA_ORIGINS`.

## Not supported

- **Browsers other than Chrome/Edge**, and mobile browsers.
- **Opening a file in its default desktop app** (browser version only; the desktop app can). A web page cannot launch programs. The "no preview" card shows the file's
  location so you can open it from File Explorer, plus a button that lets the browser try to open it in a new tab.
- **Preview of** legacy `.doc`, `.ppt`/`.pptx`, `.odt`, archives, and audio/video codecs the browser can't play (e.g. some
  `.mov`, `.avi`, `.mkv`). These get the file-info card.
- **docx fidelity:** fonts, colors, headers/footers, page layout and some elements are dropped. It's a readable preview, not
  Word.
- **Very large files:** spreadsheets show the first 2,000 rows × 200 columns, text files the first 5 MB, and syntax
  highlighting turns off above 1 MB. PDFs only render the pages near the screen.
- **Password-protected PDFs.**
- **Dropping folders** from your PC (drop the files instead, or create a subfolder first).
- By design (out of scope): text-selection highlighting, timestamped comments on audio/video, editing original files, OCR,
  accounts, a backend and real-time collaboration. The only network requests are the AI assistant's, to the server you
  configure.

## Notes and limitations

- `.noteTOO` starts with a dot but Windows does not hide it automatically. Hide it via *Properties → Hidden* if you like;
  NoteTOO finds it either way.
- Windows path length: sidecars add `.noteTOO\` and `.annotations.json` to the path. With very deep folders, Windows'
  260-character limit can make a sidecar unwritable; you would see a save error, never a silent loss.
- Rename/move uses the browser's native move when available and otherwise copies then deletes. With the copy fallback,
  moved files get a new modified date.
- `npm audit` reports a moderate advisory in `sprintf-js`, a dependency of mammoth's command-line tool. That code is not
  part of the browser bundle.
- SheetJS is installed from its official source (`cdn.sheetjs.com` tarball) at install time, because the npm registry copy
  is outdated. At runtime everything is bundled and the app makes no network requests.

## Code layout

```
electron/main.mts        desktop app: window, native folder dialog, app settings, IPC, app:// protocol
electron/disk.mts        desktop app: disk access for the opened folder (the trust boundary), atomic writes,
                         Recycle Bin, notetoo-file:// streaming with range requests
electron/preload.cts     desktop app: the narrow window.notetoo bridge (contract: src/desktop/bridge.ts)
src/
  fs/fsService.ts        the only module that touches the File System Access API
  fs/paths.ts            pure path rules: sections, ignore list, sidecar path mirroring, name validation
  fs/sidecar.ts          sidecar parsing/validation/serialization and broken-file backup
  fs/memoryFs.ts         in-memory folder used by tests and the dev-only sample mode
  fs/nativeFs.ts         desktop app: the same handle interface, backed by electron/disk.mts
  state/AppContext.tsx   app state (in memory) and file operations (create/rename/move/delete/add)
  state/useDiskDoc.ts    file-backed document: load, debounced save, conflict detection
  state/AiContext.tsx    AI assistant state: conversation, running task, highlight suggestions, organize review
  ai/client.ts           the only module that talks to an AI server (Ollama native API or OpenAI-compatible)
  ai/extract.ts          file -> text per page (with positions for highlights) or images for the vision model
  ai/tasks.ts            prompts and steps of each AI feature (long files are read in parts)
  ai/organize.ts         validates the model's proposed paths into a safe move/rename plan
  ai/text.ts, json.ts    quote matching, chunking, JSON answer parsing (unit-tested)
  ai/guide.ts            the in-app guide given to the model and the "Show me" targets
  ai/settings.ts         per-browser AI settings
  components/            sidebar, top bar, subject pages, previews, annotations, notes, ai/
```
