# Prompt: Build "NoteTOO", a local school-files organizer

Paste everything below the line into Claude Code, started in an empty project folder.

---

## Goal

Build a **fully local web app** that helps me organize my school subjects and their files (courses, TDs, TPs, exams, anything). I can preview any file inside the app, take notes, add comments, and highlight areas on previewed files. Everything I create must be saved **as real files in a folder on my PC**. My cloud drive (OneDrive / Google Drive Desktop) already syncs that folder, so the app itself does no syncing and has no backend.

The app only **organizes, previews and annotates**. The folder on disk is the single source of truth.

## Hard constraints (do not break these)

1. **No IndexedDB, no localStorage, no sessionStorage, no cookies, no Cache API for data.** Nothing I create may live in the browser. If I clear browser data, I must lose nothing.
2. **No backend, no database, no accounts, no network calls** for app functionality. All libraries are bundled via npm (no CDN at runtime). It must work offline.
3. All persistence goes through the **File System Access API** (`showDirectoryPicker`, readwrite). Target Chrome and Edge. If the browser doesn't support it, show a clear message instead of failing.
4. The only thing allowed to be remembered between sessions is the folder handle. Since that normally needs IndexedDB, **don't persist it**. On each launch, show a "Open my school folder" button and re-ask for the folder. (If re-asking becomes annoying, tell me about the trade-off. Do not add storage on your own.)
5. **Never modify, rename or delete my original files** unless I explicitly use an in-app action (Rename, Move, Delete) and confirm it. Annotations never alter the original file.

## Tech stack

- Vite + React + TypeScript, no backend, runs with `npm run dev` and builds to static files with `npm run build`.
- Suggested libraries (swap for better ones if you have a reason, and say why): `pdfjs-dist` (PDF), `mammoth` (docx), `xlsx` / SheetJS (xlsx), a lightweight code highlighter (e.g. `highlight.js` or `shiki`), a markdown renderer (e.g. `react-markdown`), plain `<video>` / `<audio>` / `<img>` elements.
- UI language: **English**.
- Clean, minimal, responsive layout; light and dark mode (follow the OS setting; the choice must not be stored in the browser).

## Folder structure on disk

I pick one root folder. The app treats it like this:

```
<Root>/
  <Subject name>/
    Cours/
    TD/
    TP/
    Exams/
    Other/
    _notes.md                   <- subject notes (see Notepad)
  _scratchpad.md                <- global notepad
  .noteTOO/                     <- app metadata (hidden folder)
    <path-mirroring>/<file>.annotations.json
```

- Each first-level folder in the root is a **subject**. Each subject has the five sections above (Cours, TD, TP, Exams, Other). Create missing section folders when I create a subject. If I point the app at an existing folder, adopt what's there without touching it, and show any extra subfolders under "Other".
- Inside a section, I can also create **subfolders** (e.g. `TD/TD3 - Graphs/`) and keep a few levels of nesting.
- Files can be anything. The app lists all of them and previews what it can; for unsupported types it shows a clean "no preview" card with an **Open with default app** hint and file info (name, size, modified date).
- Annotation sidecars live in `.noteTOO/` mirroring the file's relative path (so my subject folders stay clean), e.g. `.noteTOO/Maths/TD/TD3/ex2.pdf.annotations.json`. Use this exact scheme so the sidecars move with the files on sync.
- Ignore `.noteTOO/`, `_notes.md`, `_scratchpad.md`, and system files (`desktop.ini`, `.DS_Store`, `Thumbs.db`) in the file lists.

## Features

### 1. Organization
- Sidebar: list of subjects, each expandable into Cours / TD / TP / Exams / Other and their subfolders and files.
- Create, rename and delete subjects, subfolders and files (confirm destructive actions; deleting uses `removeEntry` only after an explicit confirmation dialog that names the item).
- **Add files**: drag and drop from my PC onto a section, or an "Add files" button (file picker). Files are copied into the section folder. Handle name collisions without overwriting (ask me, or suffix `(1)`).
- Move a file between sections/subjects (drag and drop in the sidebar).
- **Search**: filter by file name across everything, plus a filter by subject and section.
- Sort by name / date modified / type. Show file type icons.
- A small subject overview page showing counts per section and the most recently opened/modified files (derive "recent" from file modified times on disk, not from stored state).

### 2. File preview (in the app, no download needed)
| Type | Preview |
|---|---|
| PDF | PDF.js viewer: zoom, page navigation, continuous scroll, fit-to-width, text selection, search in document |
| Images (png, jpg, jpeg, webp, gif, svg) | Zoom and pan |
| docx | Rendered with mammoth to HTML (read-only, say so if formatting is simplified) |
| xlsx (and csv) | SheetJS table view, with a sheet tab for each sheet |
| Video (mp4, webm) / Audio (mp3, wav, m4a, ogg) | Native player with speed control |
| txt / md | Text view; md rendered as formatted markdown, with a toggle for raw |
| Code (py, js, ts, c, cpp, java, html, css, json, sql, etc.) | Syntax-highlighted view with line numbers |

Preview opens in the main panel. Large files must not freeze the UI (lazy render PDF pages, stream media via object URLs and revoke them afterward).

### 3. Annotations: comments and highlights (saved to disk)
- **Area highlight** on **PDFs and images**: I drag a rectangle over the previewed page/image, choose a color (at least yellow, green, pink, blue), and the area is highlighted.
- Each highlight can carry a **comment** (text). I can also add a standalone **comment pin** on a point of a page/image.
- A side panel lists all annotations for the open file (page number, color, comment text). Clicking one scrolls to it and flashes it. I can edit the comment, change the color, and delete an annotation.
- Annotations are stored in coordinates **relative to the page/image** (normalized 0-1) so they stay correct at any zoom level.
- For files without area highlight (docx, xlsx, video, audio, text, code), I can still add **file-level comments** (a list of notes attached to the file) from the same side panel.
- **Save**: auto-save to the sidecar JSON a moment after each change (debounced), write atomically if possible (write temp, then replace). Show a small "Saved" / "Saving..." indicator and a visible error if a write fails.
- Sidecar format example:
  ```json
  {
    "version": 1,
    "file": "Maths/TD/TD3/ex2.pdf",
    "fileComments": [{ "id": "...", "text": "...", "createdAt": "ISO-8601" }],
    "annotations": [
      {
        "id": "uuid",
        "type": "area",
        "page": 2,
        "rect": { "x": 0.12, "y": 0.30, "w": 0.40, "h": 0.08 },
        "color": "yellow",
        "comment": "Check this formula",
        "createdAt": "ISO-8601",
        "updatedAt": "ISO-8601"
      }
    ]
  }
  ```
- If a file is renamed or moved inside the app, move its sidecar with it. If the sidecar is malformed, back it up as `*.broken.json` and start fresh, never crash.

### 4. Notepad
- **Per-subject notes**: a markdown notepad for each subject, saved as `<Subject>/_notes.md`. Open it from the subject page.
- **Global scratchpad**: one markdown notepad saved as `<Root>/_scratchpad.md`, reachable from anywhere (e.g. a button in the top bar or a slide-over panel) so I can jot something down while a file is open next to it.
- Editor: simple markdown editor with live preview toggle (bold, lists, headings, checkboxes), auto-save to disk with the same Saved/Saving indicator.
- If the file on disk changed outside the app since I opened it (e.g., drive sync from another device), detect it by comparing `lastModified` before writing and ask me to **reload or overwrite** instead of silently clobbering.

### 5. Layout
- Left: sidebar (subjects/sections/files, search).
- Center: preview of the selected file.
- Right: collapsible annotations/comments panel for the open file.
- Top bar: folder name, global search, scratchpad button, theme follows the OS.
- Responsive enough to use on a laptop screen; keyboard shortcuts for the basics (search, toggle panels, next/prev page).

## Edge cases to handle
- Permission lost/revoked: show a "Reconnect to folder" prompt.
- Folder changed outside the app (sync, manual edits): provide a **Refresh** button and re-scan on window focus.
- Huge folders: lazy-load folder contents; don't read file contents until opened.
- Unicode and spaces in file names (French accents especially); long paths.
- Two files with the same name in different folders must not share an annotation sidecar (hence the path-mirroring scheme).
- Unsupported browser: clear message that Chrome or Edge is required.

## Working method
1. First, **read this whole prompt and reply with a short plan** (architecture, folder layout of the code, the file-access layer design, the data model). Wait for my OK before coding.
2. Build in phases and verify each in the browser before moving on:
   - Phase 1: folder access layer + sidebar + subject/section/file management.
   - Phase 2: previews for all file types.
   - Phase 3: annotations (area highlights, comments) with sidecar saving.
   - Phase 4: notepad (subject + global) with conflict detection.
   - Phase 5: polish (search, shortcuts, dark mode, error handling).
3. Keep file-system access behind a single small module (`fsService`) so the rest of the app never touches the File System Access API directly. Write unit tests for the sidecar read/write and the path-mirroring logic.
4. Test with a sample folder you generate (a few subjects with PDFs, an image, a docx, an xlsx, an mp4/mp3, md and code files). Don't ever run destructive operations against any real folder of mine.
5. At the end, give me a README with: how to run it, how to pick the folder, how data is stored on disk, and what's **not** supported.

## Out of scope (do not build)
Accounts, login, a backend, direct Google Drive / OneDrive API calls, mobile app, real-time collaboration, text-selection highlighting, timestamp comments on video/audio, editing the original files, OCR, AI features. If something here seems impossible, say so instead of working around the constraints above.
