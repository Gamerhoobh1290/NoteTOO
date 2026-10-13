// "Show me" buttons in AI answers: the model writes [[show:<id>]] and the panel turns each valid
// id into a button that opens the right place and outlines the control to use.

export interface ShowTarget {
  label: string;
  /** CSS selector of the control to outline */
  selector: string;
  /** where it lives, for opening the right view first */
  needs: 'any' | 'home' | 'subject' | 'viewer';
}

export const SHOW_TARGETS: Record<string, ShowTarget> = {
  sidebar: { label: 'Sidebar', selector: '.sidebar', needs: 'any' },
  search: { label: 'File search', selector: '.search', needs: 'any' },
  'new-subject': { label: 'New subject', selector: '[data-tour="new-subject"]', needs: 'home' },
  'add-files': { label: 'Add files', selector: '[data-tour="add-files"]', needs: 'subject' },
  'to-sort': { label: 'To sort tray', selector: '[data-tour="to-sort"]', needs: 'subject' },
  'subject-notes': { label: 'Subject notes', selector: '[data-tour="subject-notes"]', needs: 'subject' },
  scratchpad: { label: 'Scratchpad', selector: '[data-tour="scratchpad"]', needs: 'any' },
  annotations: { label: 'Annotations panel', selector: '[data-tour="annotations"]', needs: 'any' },
  'highlight-tool': { label: 'Highlight tool', selector: '[data-tour="tool-area"]', needs: 'viewer' },
  'pin-tool': { label: 'Comment pin tool', selector: '[data-tour="tool-pin"]', needs: 'viewer' },
  refresh: { label: 'Refresh', selector: '[data-tour="refresh"]', needs: 'any' },
  shortcuts: { label: 'Keyboard shortcuts', selector: '[data-tour="shortcuts"]', needs: 'any' },
  'ai-settings': { label: 'AI settings', selector: '[data-tour="ai-settings"]', needs: 'any' },
  'ai-actions': { label: 'AI quick actions', selector: '[data-tour="ai-actions"]', needs: 'any' },
};

export type AnswerPart = { kind: 'text'; text: string } | { kind: 'show'; id: string };

/** Splits an answer into text and valid "Show me" ids (unknown ids are dropped; "show:" is optional). */
export function parseShowLinks(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const m of answer.matchAll(/\[\[\s*(?:show\s*:\s*)?([a-z-]+)\s*\]\]/gi)) {
    const before = answer.slice(last, m.index);
    if (before) parts.push({ kind: 'text', text: before });
    const id = m[1].toLowerCase();
    if (SHOW_TARGETS[id]) parts.push({ kind: 'show', id });
    last = m.index + m[0].length;
  }
  const rest = answer.slice(last);
  if (rest) parts.push({ kind: 'text', text: rest });
  return parts;
}

/** NoteTOO's user guide, written for the model. Keep in sync with the README. */
export const HELP_TEXT = `NoteTOO is a local web app (Chrome/Edge) to organize, preview and annotate school files. Everything is saved as normal files in the user's own folder (often synced by OneDrive/Google Drive). No account, no backend.

FOLDER STRUCTURE
- The user picks a root folder each time the app starts ("Open my school folder"). Each first-level folder is a subject.
- Each subject has five sections: Cours (lessons), TD (tutorial exercises), TP (lab work), Exams, Other. Section folders are created when a subject is created in the app.
- Subfolders can be created inside sections (e.g. TD/TD3 - Graphes). Loose files in a subject or in Other appear in the subject's "To sort" tray.
- Notes: each subject has _notes.md (Notes button on the subject page). The global scratchpad is _scratchpad.md (Scratchpad button in the top bar, Alt+3).
- Annotations are stored in .noteTOO/ next to the files' paths; original files are never modified.

ORGANIZING
- Sidebar (Alt+1): subjects > sections > subfolders > files. Right-click or the "…" button on a row for Rename, Move, Delete, New folder.
- New subject: button on the home page ("Subjects").
- Add files: "Add files" button on a subject page, or drag files from the PC onto a subject, section, or folder (they are copied, never overwritten; duplicates get "name (1).ext").
- Move: drag any file onto any folder (sidebar, section tiles, subfolder chips). A toast offers Undo. Or right-click > Move to….
- To sort tray (subject page): one-click buttons send a loose file to Cours / TD / TP / Exams.
- Multi-select: Ctrl+click or Shift+click files, then drag them, or use the selection bar (Move to… / Delete…). Esc clears the selection.
- Search: Ctrl+K or / searches file names in all subjects (accent-insensitive), with subject/section filters. Refresh button re-scans the folder.
- Delete always asks for confirmation.

PREVIEWS
- PDF: scroll, zoom (+/−), fit to width, page navigation (← →), search in PDF (Ctrl+F), text selection.
- Images (zoom/pan), Word .docx (simplified), spreadsheets xlsx/xls/ods/csv (one tab per sheet), video/audio (speed control), markdown (formatted or raw), text and code with syntax highlighting.
- Unsupported types (.doc, .pptx, archives…) show a file info card; open them from File Explorer.

ANNOTATIONS (PDF and images)
- Highlight tool (H): drag a rectangle to highlight an area; 4 colors (yellow, green, pink, blue).
- Comment pin tool (C): click to drop a pin with a comment. Select tool (V).
- Annotations panel (Alt+2): lists highlights and pins; click one to jump to it; edit its comment or color, or delete it. Every file (any type) can also have file comments there.
- Saving is automatic (~0.7 s). If a file changed on disk (sync), NoteTOO asks: Reload from disk or Overwrite.

AI ASSISTANT (this panel, Alt+4)
- Quick actions on an open file: Summarize, Explain, Highlight important. Select text in a file and click "Explain" to explain just that passage.
- "Highlight important" proposes purple highlights on PDFs (Keep / Discard each, in the annotations panel); for other files it lists key points.
- On a subject page: "Organize this subject". On the home page: "Organize everything". The AI proposes moves, renames and new folders; the user reviews a checklist and applies; Undo is offered.
- "Save to notes" on an answer appends it to the subject's _notes.md (or the scratchpad).
- AI settings (status chip at the top of the panel): Ollama on this PC, OpenRouter, or any OpenAI-compatible server; text model and optional vision model (for images and scanned PDFs). Settings are kept in this browser only.

KEYBOARD SHORTCUTS: Ctrl+K or / search · Alt+1 sidebar · Alt+2 annotations panel · Alt+3 scratchpad · Alt+4 AI panel · ← → or P N pages · + − zoom · Ctrl+F search in PDF · V H C tools · Ctrl+B / Ctrl+I bold/italic in notes · ? all shortcuts.

NOT SUPPORTED: browsers other than Chrome/Edge, mobile, opening files in desktop apps, editing original files, OCR, password-protected PDFs, dropping whole folders from the PC.`;
