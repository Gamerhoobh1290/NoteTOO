// The AI features: prompts and the steps behind each quick action.

import { AiError, chat, type ChatMessage } from './client';
import type { AiDoc } from './extract';
import { HELP_TEXT, SHOW_TARGETS } from './guide';
import { InvalidAnswer, arrayField, askJson, isObj } from './json';
import { ORGANIZE_SCHEMA, parseProposals, type Proposal } from './organize';
import type { AiSettings } from './settings';
import { chunkPages, findQuote, inputBudget, locateQuote, type Chunk } from './text';
import type { Rect } from '../fs/sidecar';

export interface TaskCtx {
  s: AiSettings;
  signal: AbortSignal;
  /** short status line, e.g. "Reading pages 21–40…" */
  progress: (msg: string) => void;
  /** streamed visible answer */
  onToken: (text: string) => void;
}

const STYLE =
  'Use clear Markdown: short headings, bullet points, bold for key terms. Write formulas in plain text with Unicode symbols (e.g. ∫₀¹ x² dx = 1/3), never LaTeX.';

const STUDY_ROLE = 'You are a patient study assistant inside NoteTOO, a school-files app. Be accurate; never invent content that is not in the document.';

/** Ends every request about a document: small models follow the last instruction best. */
const inDocLanguage = (task: string) => `${task}\nWrite your whole answer in the language of the document (a French document gets a French answer).`;

function requireVision(s: AiSettings) {
  if (!s.visionModel) {
    throw new AiError('Reading images and scanned PDFs needs a vision model. Choose one in AI settings (for Ollama, e.g. qwen3.5 or gemma3).', 'model');
  }
}

function docHeader(name: string, doc: AiDoc): string {
  if (doc.kind === 'image') return `File: "${name}" (${doc.scanned ? 'scanned PDF, first pages attached as images' : 'image attached'})`;
  return `File: "${name}"${doc.kind === 'text' && doc.truncated ? ' (only the beginning could be read)' : ''}`;
}

/** Runs a "read the whole document" task: one request if it fits, else per chunk then combined. */
async function overDocument(
  ctx: TaskCtx,
  name: string,
  doc: AiDoc,
  o: { task: string; partTask: string; combineTask: string },
): Promise<string> {
  if (doc.kind === 'none') throw new AiError(doc.reason);
  o = { task: inDocLanguage(o.task), partTask: inDocLanguage(o.partTask), combineTask: inDocLanguage(o.combineTask) };
  if (doc.kind === 'image') {
    requireVision(ctx.s);
    ctx.progress('Looking at the image…');
    return chat(ctx.s, {
      vision: true,
      signal: ctx.signal,
      onToken: ctx.onToken,
      messages: [
        { role: 'system', content: `${STUDY_ROLE} ${STYLE}` },
        { role: 'user', content: `${docHeader(name, doc)}\n\n${o.task}`, images: doc.images },
      ],
    });
  }
  const budget = inputBudget(ctx.s.contextTokens);
  const chunks = chunkPages(doc.pages, budget, doc.paged);
  if (!chunks.length) throw new AiError('This file has no readable text.');
  if (chunks.length === 1) {
    ctx.progress('Reading…');
    return chat(ctx.s, {
      signal: ctx.signal,
      onToken: ctx.onToken,
      messages: [
        { role: 'system', content: `${STUDY_ROLE} ${STYLE}` },
        { role: 'user', content: `${docHeader(name, doc)}\n\n<document>\n${chunks[0].text}\n</document>\n\n${o.task}` },
      ],
    });
  }
  const notes: string[] = [];
  for (const [i, c] of chunks.entries()) {
    ctx.progress(`${partLabel(c, doc.paged)} (${i + 1}/${chunks.length})…`);
    const part = await chat(ctx.s, {
      signal: ctx.signal,
      messages: [
        { role: 'system', content: `${STUDY_ROLE} ${STYLE}` },
        { role: 'user', content: `${docHeader(name, doc)}, part ${i + 1} of ${chunks.length}.\n\n<document>\n${c.text}\n</document>\n\n${o.partTask}` },
      ],
    });
    notes.push(`### ${partLabel(c, doc.paged)}\n${part}`);
  }
  ctx.progress('Putting it together…');
  const per = Math.floor(budget / notes.length);
  return chat(ctx.s, {
    signal: ctx.signal,
    onToken: ctx.onToken,
    messages: [
      { role: 'system', content: `${STUDY_ROLE} ${STYLE}` },
      { role: 'user', content: `${docHeader(name, doc)}. Notes taken on each part:\n\n${notes.map((n) => n.slice(0, per)).join('\n\n')}\n\n${o.combineTask}` },
    ],
  });
}

const partLabel = (c: Chunk, paged: boolean) => (!paged ? 'Reading' : c.from === c.to ? `Reading page ${c.from}` : `Reading pages ${c.from}–${c.to}`);

export function summarize(ctx: TaskCtx, name: string, doc: AiDoc): Promise<string> {
  return overDocument(ctx, name, doc, {
    task: 'Summarize this document for a student revising it: start with one sentence on what it is about, then the main points, definitions, formulas and results. Keep it concise.',
    partTask: 'Write dense bullet-point notes of the main points, definitions, formulas and results in this part.',
    combineTask: 'Combine these notes into one well-structured summary for a student revising: one sentence on what the document is about, then the main points, definitions, formulas and results. Remove repetition.',
  });
}

export function explain(ctx: TaskCtx, name: string, doc: AiDoc): Promise<string> {
  return overDocument(ctx, name, doc, {
    task: 'Explain this document like a good teacher: what it is for, the key ideas in a logical order, simple explanations and small examples for the hard parts, and what a student must understand or know how to do.',
    partTask: 'List the key ideas of this part and what is hard to understand in it, with short explanations.',
    combineTask: 'Using these notes, explain the whole document like a good teacher: what it is for, the key ideas in a logical order, simple explanations and small examples for the hard parts, and what a student must understand or know how to do.',
  });
}

/** Explains a passage the user selected, with the surrounding text for context. */
export function explainPassage(ctx: TaskCtx, name: string, doc: AiDoc, passage: string): Promise<string> {
  let context = '';
  if (doc.kind === 'text') {
    const all = doc.pages.join('\n\n');
    const room = Math.floor(inputBudget(ctx.s.contextTokens) / 2);
    const at = findQuote(all, passage)?.start ?? 0;
    context = all.slice(Math.max(0, at - room / 2), at + room / 2);
  }
  ctx.progress('Explaining…');
  return chat(ctx.s, {
    signal: ctx.signal,
    onToken: ctx.onToken,
    messages: [
      { role: 'system', content: `${STUDY_ROLE} ${STYLE}` },
      {
        role: 'user',
        content:
          `${docHeader(name, doc)}\n\n` +
          (context ? `Surrounding text, for context:\n<document>\n${context}\n</document>\n\n` : '') +
          `Explain this passage clearly, step by step, with a simple example if it helps:\n<passage>\n${passage.slice(0, 4000)}\n</passage>\nWrite your answer in the language of the passage.`,
      },
    ],
  });
}

export interface KeyPoint {
  /** 1-based page (1 for files without pages) */
  page: number;
  quote: string;
  why: string;
  /** PDF only: where the quote is on the page */
  rect?: Rect;
}

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: { page: { type: 'integer' }, quote: { type: 'string' }, why: { type: 'string' } },
        required: ['page', 'quote', 'why'],
      },
    },
  },
  required: ['highlights'],
};

function parseHighlights(v: unknown) {
  return arrayField(v, 'highlights').map((h, i) => {
    if (!isObj(h) || typeof h.quote !== 'string' || typeof h.why !== 'string') {
      throw new InvalidAnswer(`highlights[${i}] must have a string "quote" and "why".`);
    }
    return { page: typeof h.page === 'number' ? Math.round(h.page) : 0, quote: h.quote.trim(), why: h.why.trim() };
  });
}

/** Finds the most important passages; only quotes that really are in the document are kept. */
export async function findHighlights(ctx: TaskCtx, name: string, doc: AiDoc): Promise<KeyPoint[]> {
  if (doc.kind !== 'text') throw new AiError('Highlights work on files with text (PDFs, documents, notes, code).');
  const chunks = chunkPages(doc.pages, inputBudget(ctx.s.contextTokens), doc.paged);
  if (!chunks.length) throw new AiError('This file has no readable text.');
  const out: KeyPoint[] = [];
  for (const [i, c] of chunks.entries()) {
    ctx.progress(chunks.length > 1 ? `${partLabel(c, doc.paged)} (${i + 1}/${chunks.length})…` : 'Reading…');
    const max = Math.min(10, Math.max(3, Math.round((c.to - c.from + 1) * 1.5)));
    const found = await askJson(ctx.s, {
      signal: ctx.signal,
      schema: HIGHLIGHT_SCHEMA,
      validate: parseHighlights,
      messages: [
        {
          role: 'system',
          content: `${STUDY_ROLE} You pick the passages a student must not miss: definitions, theorems, key formulas, methods, important results, warnings. Answer with JSON only.`,
        },
        {
          role: 'user',
          content:
            `${docHeader(name, doc)}\n\n<document>\n${c.text}\n</document>\n\n` +
            `Pick at most ${max} of the most important passages. For each: "page" (the [Page n] it is on${doc.paged ? '' : '; use 1'}), ` +
            `"quote" (copied EXACTLY, word for word, from the document: one sentence or line, 4 to 40 words), and ` +
            `"why" (one short sentence on why it matters, in the document's language). JSON: {"highlights":[{"page":1,"quote":"…","why":"…"}]}`,
        },
      ],
    });
    for (const h of found) {
      if (doc.layout) {
        // Prefer the page the model named, then any page of the chunk.
        const pages = [h.page, ...Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k)].filter((p) => p >= c.from && p <= c.to);
        for (const p of pages) {
          const rect = locateQuote(doc.layout[p - 1], h.quote);
          if (rect) {
            out.push({ page: p, quote: h.quote, why: h.why, rect });
            break;
          }
        }
      } else if (findQuote(doc.pages.join('\n'), h.quote)) {
        out.push({ page: 1, quote: h.quote, why: h.why });
      }
    }
  }
  if (!out.length) throw new AiError('The model did not quote the document accurately enough to place highlights. Try again, or use a bigger model.');
  // Drop duplicates (overlapping boxes on the same page).
  return out.filter((k, i) => !out.slice(0, i).some((o) => o.page === k.page && o.quote === k.quote));
}

/** Free chat: questions about the open file, or about how to use NoteTOO. */
export function answer(
  ctx: TaskCtx,
  history: ChatMessage[],
  where: string,
  file: { name: string; doc: AiDoc } | null,
): Promise<string> {
  let fileContext = '';
  let images: string[] | undefined;
  if (file?.doc.kind === 'text') {
    const all = file.doc.pages.join('\n\n');
    const room = Math.floor(inputBudget(ctx.s.contextTokens) * 0.6);
    fileContext = `\n\nThe open file "${file.name}"${all.length > room ? ' (beginning only)' : ''}:\n<document>\n${all.slice(0, room)}\n</document>`;
  } else if (file?.doc.kind === 'image' && ctx.s.visionModel) {
    fileContext = `\n\nThe open file "${file.name}" is attached as an image.`;
    images = file.doc.images;
  }
  const system =
    `You are the assistant built into NoteTOO. You help with two things: (1) questions about the user's school documents, ` +
    `(2) how to use NoteTOO, using ONLY the guide below (never invent features or buttons). ` +
    `When pointing the user to a place in the app, add a button by writing [[show:ID]] (for example: "Open the scratchpad [[show:scratchpad]]") with one of these IDs: ` +
    `${Object.entries(SHOW_TARGETS).map(([id, t]) => `${id} (${t.label})`).join(', ')}. ` +
    `Answer in the language the user writes in. Be concise; use Markdown; write formulas in plain text, never LaTeX.\n\n<guide>\n${HELP_TEXT}\n</guide>\n\nThe user is currently ${where}.${fileContext}`;
  const recent = history.slice(-10);
  const last = recent[recent.length - 1];
  ctx.progress('Thinking…');
  return chat(ctx.s, {
    signal: ctx.signal,
    onToken: ctx.onToken,
    vision: !!images,
    messages: [{ role: 'system', content: system }, ...recent.slice(0, -1), { ...last, ...(images ? { images } : {}) }],
  });
}

/** One-line description of an image, used as its "content" when organizing. */
export async function describeImage(s: AiSettings, images: string[], signal: AbortSignal): Promise<string> {
  const text = await chat(s, {
    vision: true,
    signal,
    messages: [
      {
        role: 'user',
        content: 'In one sentence, what is this school document or image about (subject, topic, and whether it is a course, exercise sheet, lab, exam…)?',
        images: images.slice(0, 1),
      },
    ],
  });
  return text.trim().slice(0, 300);
}

export interface FileCard {
  id: number;
  path: string;
  size: string;
  excerpt: string;
}

export function proposeOrganization(
  ctx: TaskCtx,
  o: { folders: string[]; cards: FileCard[]; scope: string; batch: string },
): Promise<Proposal[]> {
  ctx.progress(o.batch);
  return askJson(ctx.s, {
    signal: ctx.signal,
    schema: ORGANIZE_SCHEMA,
    validate: parseProposals,
    messages: [
      {
        role: 'system',
        content:
          'You organize a student\'s school folder. Layout: <Subject>/<Section>/[subfolders…]/<file>. Sections are exactly: ' +
          'Cours (lessons, course chapters, slides), TD (exercise sheets, tutorials, their solutions), TP (lab work, practicals, code projects), ' +
          'Exams (exams, tests, past papers and their corrections), Other (anything else). Rules:\n' +
          '- Use existing subjects and subfolders whenever they fit. Create a new subject only if a file clearly belongs to none of the existing ones.\n' +
          '- Create a subfolder only when several files clearly belong together (e.g. "TD3 - Graphes").\n' +
          '- Rename a file only when its name is unclear (e.g. "scan_001.pdf", "IMG_2034.jpg", "document (3).pdf"); keep clear names; keep the extension; write names in the language of the content.\n' +
          '- Only list files that should change. Leave files that are already in a sensible place out of the answer.\n' +
          '- "target" is the full new path from the root, e.g. "Maths/TD/TD3 - Graphes/ex2.pdf". "reason" is one short sentence.\n' +
          'Answer with JSON only: {"files":[{"id":3,"target":"…","reason":"…"}]}',
      },
      {
        role: 'user',
        content:
          `Scope: ${o.scope}\n\nExisting folders:\n${o.folders.join('\n') || '(none)'}\n\nFiles (id | current path | size | content):\n` +
          o.cards.map((c) => `#${c.id} | ${c.path} | ${c.size} | ${c.excerpt || '(content not readable)'}`).join('\n'),
      },
    ],
  });
}
