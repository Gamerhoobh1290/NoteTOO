# NoteTOO

A local app to organize, preview and annotate your school files, as a [Windows desktop app](#windows-desktop-app), in
Chrome/Edge, or [from your laptop's browser with your main PC doing the work](#use-notetoo-from-your-laptop-notetoo-server).
Everything it creates is saved as normal files in **your own folder**; there is no cloud service and no account. If your folder is synced by OneDrive or Google Drive Desktop, your
notes and annotations are synced with it. An optional [AI assistant](#ai-assistant) can summarize, explain and highlight
your files, guide you through the app, and propose how to organize your folder, using a model on your own PC (Ollama) or a
provider you choose. With the NoteTOO server, the [AI agent](#ai-agent-notetoo-server) works with your whole school folder on
the PC: it finds and reads your files, creates and changes documents, and runs tasks for you.

## Requirements

- **Google Chrome or Microsoft Edge** (desktop), recent version. NoteTOO uses the File System Access API, which other
  browsers do not support; they get a clear message instead.
- Node.js 20+ to build and run it; the [NoteTOO server](#use-notetoo-from-your-laptop-notetoo-server)'s AI agent needs
  Node.js 22.13+ (22 LTS or later) to read PDFs.

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
| `npm test` | Unit tests (path mirroring, sidecar read/write, file operations on an in-memory folder, AI answer validation and organize planning), plus the desktop disk backend, the Receive-from-phone server and the NoteTOO server with its AI agent (Ollama and OpenAI wire formats, tools, Python) on a real temporary folder |
| `npm run sample` | Generates `./sample-school/`, a throwaway test folder (`-- --force` regenerates it) |
| `npm run server` | Builds the web app and starts the [NoteTOO server](#use-notetoo-from-your-laptop-notetoo-server) (`NoteTOO-Server.cmd` does the same) |

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
folder, theme, the Receive-from-phone port). The AI settings live in the app's local storage in the same `%APPDATA%\NoteTOO` folder. Your notes and
annotations stay in your school folder exactly as in the browser version. Uninstalling keeps `%APPDATA%\NoteTOO`;
delete it to reset the app.

**Security:** the page has no Node.js access. It asks the main process (`electron/`) for disk operations by (opened
folder, relative path), and the main process refuses any path outside the folder you opened. Links in notes and AI
answers open in your default browser.

### Receive from phone

Send photos and videos from your phone into your folder in **original quality** (messaging apps recompress them),
over your own Wi-Fi: no cloud, no account, nothing leaves your network.

1. Click the **phone** button in the top bar and switch receiving on. The first time, Windows may ask whether
   NoteTOO can use the network: allow it on **private networks**.
2. On the phone (same Wi-Fi), scan the QR code with the camera, or open the address shown in Safari and type the
   access key.
3. Pick the folder ("Save in"; by default **Inbox** at the root of your folder, created when needed), then
   **Choose photos & videos**. Each file shows its progress; failed ones have **Retry**.
4. NoteTOO re-scans the folder as files arrive and says where they went; the dialog lists everything received.
   Switch it off when you're done. It also stops when you close or switch folders, and when NoteTOO exits.

- **iPhone, full quality:** in the photo picker, tap **Options** and choose **Format: Current**. With *Automatic*,
  iOS may convert HEIC photos to JPEG before Safari hands them over.
- Files are saved exactly as received (no resizing or re-encoding), through a temporary file, and never replace an
  existing file: a name already taken becomes `name (1).ext`. Windows marks them as coming from the network, like
  browser downloads, so it warns before running a program and opens Office files in Protected View.
- The page can be added to the phone's Home Screen. The port stays the same between sessions; the key changes every
  time you switch receiving on (or click **New key**), so the Home Screen app asks for it again.
- **Security:** plain HTTP on your local network. The key keeps others on the network out (10 wrong keys lock that
  device out for 10 minutes), but the traffic is not encrypted: don't use it on public Wi-Fi. The server only
  answers on this PC's private network addresses, rejects other host names and cross-site requests, accepts only
  photos and videos up to 4 GB each (keeping 1 GB of disk free), and only writes inside the opened folder (never in
  `.noteTOO` or hidden folders, never through links or short names that lead elsewhere).

## Use NoteTOO from your laptop (NoteTOO server)

Your main PC runs the **NoteTOO server**; your laptop just opens NoteTOO in its browser. Everything happens on the PC:
your files and notes stay there (nothing is copied or synced to the laptop), every change is saved there, and the AI
runs there (Ollama on the PC, with its GPU). The laptop needs no installation, no AI and no copy of your folder.

```
 Laptop (any browser)                      Main PC (NoteTOO server, Node.js)
 ┌─────────────────────┐  HTTP(S), signed-in  ┌─────────────────────────────────────────────┐
 │ NoteTOO web app     │ ───────────────────▶ │ server/app.mts                              │
 │ (same UI as the     │ ◀─────────────────── │  ├ disk.mts: shared folders only            │
 │  desktop app)       │   streamed answers,  │  ├ AI proxy → Ollama (localhost:11434)      │
 │                     │   agent progress     │  └ agent/: tools, search index, Python,     │
 │                     │                      │       model calls (Ollama or an API)        │
 └─────────────────────┘                      └─────────────────────────────────────────────┘
```

### Set it up on the main PC (once)

1. Install [Node.js](https://nodejs.org) 22 LTS or later (20 works, but then the AI agent cannot read PDFs), and get this
   NoteTOO folder on the PC. For the agent's scripts, also install [Python](https://python.org) 3.8+ (optional).
2. Share your school folder. Only shared folders can be opened from the laptop; nothing else on the PC is reachable:

   ```bash
   NoteTOO-Server.cmd --add-folder "D:\OneDrive\École"
   ```

   On the first start, the folders the desktop app already knows are shared automatically.
3. Start it: **double-click `NoteTOO-Server.cmd`**. The first time it installs dependencies; every start builds the app
   (a few seconds) and then shows:

   ```
   On this PC:           http://localhost:8787
   Same Wi-Fi / network: http://192.168.1.89:8787
   Tailscale (anywhere): http://100.101.102.103:8787
   Access key: T5DM-HJTM-E3W4
   ```

   Keep the window open: closing it (or `Ctrl+C`) stops NoteTOO for the laptop. The PC must stay on and awake
   (Settings → System → Power: set *Sleep* to *Never* when plugged in, or long enough for your sessions).
4. The first time, Windows Firewall asks whether **Node.js** may use the network: allow it on **private networks**.

To start it automatically when you sign in to the PC: press `Win+R`, type `shell:startup`, and put a shortcut to
`NoteTOO-Server.cmd` in that folder.

Other commands: `NoteTOO-Server.cmd --list` (shared folders, port and access key), `--remove-folder <path>`,
`--new-key` (signs every browser out), `--port <n>`, `--help`. They apply to a running server right away.

### On the laptop, at home

Open the **Same Wi-Fi / network** address in any browser (Chrome, Edge, Firefox, Safari), type the access key once, and
pick your folder. The browser stays signed in (30 days, renewed while you use it). Bookmark the address.

The PC's address can change when the router restarts. To keep it, give the PC a fixed address in your router (DHCP
reservation), or use the Tailscale address at home too (it never changes).

### From anywhere: Tailscale (recommended)

[Tailscale](https://tailscale.com) (free for personal use) puts your devices in a private, encrypted network. Nothing is
opened to the internet: no port forwarding, and only your own devices can reach the PC.

1. Install Tailscale on the **PC** and the **laptop** and sign in with the same account on both.
2. On the laptop, open the **Tailscale (anywhere)** address the server shows (`http://100.x.y.z:8787`), or use the PC's
   name: `http://<pc-name>:8787` (Tailscale's MagicDNS). Traffic between the two is encrypted by Tailscale (WireGuard),
   even though the address says `http`.
3. **HTTPS with a real certificate** (optional, recommended): in the Tailscale admin console, enable *MagicDNS* and
   *HTTPS certificates* (DNS page), then on the PC run once:

   ```bash
   tailscale serve --bg 8787
   ```

   NoteTOO is then at `https://<pc-name>.<your-tailnet>.ts.net`, for your devices only. This also works when Windows
   Firewall blocks the Tailscale network, because Tailscale connects to the server on the PC itself. To allow *only*
   this route, start the server with `NoteTOO-Server.cmd --host 127.0.0.1`.

Never forward the server's port on your router or expose it to the internet. It is meant for your home network and your
Tailscale network only (it refuses requests from public addresses anyway).

### What works the same, and what's different

Everything in NoteTOO works from the laptop: browsing, previews (PDF, images, Office files, audio/video streamed with
seeking), annotations, notes and the scratchpad, search, drag and drop (files dropped from the laptop are uploaded into
the folder on the PC), rename/move/delete (delete moves to the **PC's** Recycle Bin), and the AI assistant.

- **AI:** set it up once from any browser (**✨ AI** → status chip). The settings are kept on the PC and shared by every
  browser. *Ollama (this PC)* with `http://localhost:11434` means Ollama **on the PC**: requests go from the laptop to the
  NoteTOO server, which passes them to Ollama and streams the answer back as it is written. **Stop** stops the model too.
  For the quick actions (Summarize, Explain, Highlight, Organize), preparing a file (reading its text, rendering scanned
  pages for the vision model) still happens in the browser; the model itself always runs on the PC. The
  [AI agent](#ai-agent-notetoo-server) does everything on the PC: the laptop only sends the request and shows the progress.
- **Connection lost** (PC asleep, Wi-Fi drop, server restarted): a red banner says so and NoteTOO keeps checking. Unsaved
  edits stay in the tab; saves that failed show **Retry**. When the PC answers again, the banner goes away.
- **Signed out** (new key, or 30 days unused): the banner links to the sign-in page in a new tab, so the open tab keeps
  your edits; sign in there, then **Retry**.
- **Edits on the PC and the laptop at the same time** are handled like sync conflicts: NoteTOO notices the change and
  asks which version to keep.
- Not available from the laptop: opening files in Windows programs or File Explorer, the theme button (the browser
  follows the laptop's light/dark setting), and Receive from phone (use the desktop app on the PC for that).

### Security

- **Sign-in:** a 12-character access key (60 random bits), shown only in the server window or with `--list`. Ten wrong
  keys lock that device out for 10 minutes. The session cookie is signed, `HttpOnly` and `SameSite=Strict`.
- **Only your networks:** the server answers only to private (home network), link-local and Tailscale addresses, only
  under this PC's own names or IP addresses (protection against DNS rebinding), and accepts changes only from its own
  pages (no cross-site requests, no CORS).
- **Only your shared folders:** the browser names a folder and a path inside it; the server refuses anything outside the
  shared folders (`..`, other drives, links). This is the desktop app's trust boundary (`electron/disk.mts`). Files are
  served so that they can never run as a page.
- **Encryption:** on your home network the traffic is plain HTTP: the key keeps others out, but someone on the same Wi-Fi
  could read the traffic. Fine at home, not on public Wi-Fi. Away from home, Tailscale encrypts everything, and
  `tailscale serve` adds HTTPS.
- **AI forwarding:** the server forwards only the AI requests NoteTOO makes (chat and model list), for signed-in browsers,
  to the AI server set up in NoteTOO.
- **AI agent:** works only inside the shared folders, through the same trust boundary; what needs your approval is decided
  by the server, not by the model (see [Safety](#safety-approvals-and-undo)).
- **Settings:** `%APPDATA%\NoteTOO\server.json` (port, shared folders, key, AI and agent settings). Never in your school
  folder.

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
Ollama's `OLLAMA_ORIGINS`. (Not needed with the NoteTOO server: it talks to Ollama itself.)

## AI agent (NoteTOO server)

With the [NoteTOO server](#use-notetoo-from-your-laptop-notetoo-server), the AI panel's chat is an **agent**: it works with
your **whole school folder** on the PC, not just the open file, and it does the work instead of explaining it. You don't
open or attach anything: it finds the files itself.

```
You: "Use my management course, the professor's PDF and last week's notes to make a complete revision document."
Agent (on the PC): plan → find_files / search_content → read_documents (3 files) → create_file .docx (read back to verify)
                   → answer: what it did, where the file is, sources (file, page), overlaps, contradictions, gaps
NoteTOO: the new file appears in the sidebar and opens; "Undo these changes" puts everything back.
```

Things to ask: a revision sheet from several courses (Word), a PowerPoint from your notes, a quiz from several lessons, a
table or spreadsheet, "where is X explained in my files?", compare two documents, answer a question across a subject,
extract information from several PDFs, change a document or your notes, reorganize a subject's folders, calculations and
charts from your data (Python).

**The panel shows** the model and whether it runs on your PC, the plan, every tool step as it happens (with its result
or error), approvals waiting for you, the files created, changed or moved (with **Open**), the answer streamed as it is
written, its sources (click to open), and **Undo these changes**. The **Agent** chip in the panel's header turns it off
(the classic assistant, about the open file). "How do I…" questions about NoteTOO and "highlight …" on an open file still
use the classic assistant. If the laptop loses the connection, the task keeps running on the PC and the panel catches
up when it reconnects.

### Tools

One set of tools, the same for every model, executed on the PC:

| Tool | What it does |
|---|---|
| `workspace_overview`, `list_folder`, `find_files` | Subjects, sections, folders; files by name words, type, folder, date |
| `search_content` | Full-text search inside every readable document at once (PDF, Word, PowerPoint, spreadsheets, notes, text, code): best passages with file, page and section |
| `read_document` | One document: whole, or pages, a section, the passages about a query, or part *n* of a long one (outline first) |
| `read_documents` | Several documents in one call, focused on a topic, within one size limit |
| `get_annotations`, `notes` | Your highlights and comments; read or append to a subject's notes or the scratchpad |
| `create_file` | `.md`, `.txt`, `.csv`, code, and **Word** (`.docx` from Markdown: headings, lists, tables), **PowerPoint** (`.pptx`, one slide per heading), **Excel** (`.xlsx` from tables or CSV, `=` formulas). Every file is read back to verify it |
| `edit_file`, `edit_spreadsheet` | Exact find/replace, append, rewrite of text files and notes; cells and rows of `.xlsx` |
| `create_folder`, `move`, `delete` | Folders; moves and renames (annotations follow); delete to the Recycle Bin |
| `run_python` | A Python script on the PC for what the other tools can't do: calculations, statistics, charts, data, conversions |
| `update_plan`, `open_in_app` | Shows its plan and progress; opens the result in NoteTOO |

The **search index** is built on the PC the first time the agent is used (the AI settings show its progress), then only
new and changed files are read again, so files added from NoteTOO, File Explorer or OneDrive are found. It lives in
`%APPDATA%\NoteTOO\agent-index\`, not in your school folder. Big documents are never sent whole: the agent reads the
outline, then the pages, sections or passages it needs.

### Local models and API models

The same agent and tools work with **Ollama** (native tool calling, e.g. `qwen3.5:9b`), **OpenRouter**, and any
**OpenAI-compatible** server (LM Studio, Groq, vLLM, Ollama's `/v1`…). NoteTOO checks what the model supports: models
without native tool calling, or providers that refuse it, get the tools described in the prompt instead (one JSON
action per step; slower and less reliable), and tool calls a local model writes as text are recognized too. The context
size you set decides how much a tool result may hold and when older results are dropped; a request too long for the
model is shortened and retried. Errors (Ollama not running, model not installed, wrong key, rate limit…) are shown in
the panel.

Expect differences: a 9B local model handles short tasks well (find, read, summarize, create one document) but can lose
track in long ones, call the wrong tool, or stop early (NoteTOO nudges it when it describes the work instead of doing
it, or repeats a call). Large API models plan better and finish long multi-file tasks more reliably. Local models need a
large enough context (16384 tokens or more) for multi-file work. With an API model, the passages the agent reads are
sent to that provider.

### Safety, approvals and undo

- **Inside your shared folders only**, through the same trust boundary as the rest of the server; never `.noteTOO`,
  hidden folders, or links that lead outside.
- **The server decides what needs you, not the model:** deleting (always; to the Recycle Bin), moving more than 10 items
  or a whole subject, running a script (by default; see below) and any internet access show **Allow / Don't allow** in
  the panel with exactly what will happen (the script's code, the paths).
- **Documents are data, never instructions.** The model is told so, and even if a document tricks it, destructive
  actions still need your approval.
- **Every change is journaled**, with the previous version of each changed file kept in
  `%APPDATA%\NoteTOO\agent-backups\`. **Undo these changes** reverts a whole task (created files go to the Recycle Bin).
  Every task is logged in `%APPDATA%\NoteTOO\agent-log.jsonl` (request, tools used, files changed).
- **Python scripts** (AI settings → Agent: *Ask me before each script* (default), *Run them without asking*, or *Never*)
  run with your school folder as working directory, a time limit (60 s by default, the whole process tree is stopped),
  capped output, and a guard (Python audit hooks) that blocks writing outside the school folder, reading your other
  personal files, deleting, starting programs, native code and network access unless you approved it; files a script
  changes are backed up first. The guard prevents mistakes and tricks from documents; it is not a sandbox against
  deliberately hostile code, which is why scripts are shown to you by default. Install the libraries you want scripts
  to use (`py -m pip install pandas matplotlib python-docx openpyxl`).

### Limits

- Needs the NoteTOO server (not the desktop app on its own, nor a plain browser folder).
- No OCR: scanned PDFs and images have no text for the agent; `.doc`, `.ppt` and other old formats can't be read
  (save them as `.docx`/`.pptx`/PDF).
- Rewriting an existing `.docx`/`.pptx` regenerates it from Markdown (its original styling is lost; the old version is
  backed up). Formulas in a created `.xlsx` are computed when Excel opens it.
- Script memory is limited on Linux/macOS only; on Windows only the time is limited.

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
  accounts, a cloud backend and real-time collaboration. The only network requests are the AI assistant's, to the server
  you configure; the only network listeners are Receive from phone (desktop app), on your local network and only while
  it is switched on, and the [NoteTOO server](#use-notetoo-from-your-laptop-notetoo-server) while you run it.

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
electron/receive.mts     desktop app: Receive from phone, the LAN upload server (key, lockout, host check, streaming
                         uploads into disk.mts); electron/receive-page.html is the page it serves to the phone
server/main.mts          NoteTOO server: command line (start, --add-folder, --list…), listening, startup banner
server/app.mts           NoteTOO server: sign-in, address/host/origin checks, the disk calls (the desktop app's IPC
                         channels over HTTP, via disk.mts), file streaming, the AI proxy, serving dist/
server/config.mts        NoteTOO server: %APPDATA%\NoteTOO\server.json (shared folders, key, AI and agent settings)
server/agent/            NoteTOO server: the AI agent, run on the PC
  runner.mts             the loop (plan, tool calls, approvals, context budget, nudges), resumable events
  providers.mts          one tool-call format for Ollama and OpenAI-compatible APIs; prompted fallback
  tools.mts              the tool registry, approvals, change journal and undo
  index.mts, extract.mts file inventory and full-text index; PDF/Word/PowerPoint/spreadsheet reading in Node.js
  office.mts             .docx/.pptx/.xlsx from Markdown; python.mts: guarded Python scripts
  service.mts            runs and indexes per shared folder; agent.test.ts: end to end with Ollama/OpenAI wire formats
server/recycle.mts       NoteTOO server: Recycle Bin without Electron; server/login.html is the sign-in page
NoteTOO-Server.cmd       double-click launcher for the server (installs, builds, starts)
src/
  fs/fsService.ts        the only module that touches the File System Access API
  fs/paths.ts            pure path rules: sections, ignore list, sidecar path mirroring, name validation
  fs/sidecar.ts          sidecar parsing/validation/serialization and broken-file backup
  fs/memoryFs.ts         in-memory folder used by tests and the dev-only sample mode
  fs/nativeFs.ts         desktop app and NoteTOO server: the same handle interface, backed by electron/disk.mts
  desktop/bridge.ts      the desktop bridge contract; desktop/serverBridge.ts carries it over HTTP to the server
  state/AppContext.tsx   app state (in memory) and file operations (create/rename/move/delete/add)
  state/useDiskDoc.ts    file-backed document: load, debounced save, conflict detection
  state/AiContext.tsx    AI assistant state: conversation, running task, highlight suggestions, organize review, agent tasks
  ai/agentClient.ts      the page's side of the agent: start, follow (reconnecting), approve, stop, undo; agentView.ts
  ai/client.ts           the only module that talks to an AI server (Ollama native API or OpenAI-compatible)
  ai/extract.ts          file -> text per page (with positions for highlights) or images for the vision model
  ai/tasks.ts            prompts and steps of each AI feature (long files are read in parts)
  ai/organize.ts         validates the model's proposed paths into a safe move/rename plan
  ai/text.ts, json.ts    quote matching, chunking, JSON answer parsing (unit-tested)
  ai/guide.ts            the in-app guide given to the model and the "Show me" targets
  ai/settings.ts         per-browser AI settings
  components/            sidebar, top bar, subject pages, previews, annotations, notes, ai/
```
