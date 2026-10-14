// What the user is doing and which documents a question is about (unit-tested, no AI call):
// the intent of a request (summarize, locate, compare, study…), and document references such as
// "this file", "le contrôle de photosynthèse" or "the document I opened earlier".

import { baseName, parentPath } from '../fs/paths';
import { tokens } from './retrieve';
import { fold } from './structure';

export type Intent = 'app' | 'highlight' | 'compare' | 'summarize' | 'study' | 'locate' | 'explain' | 'question';

const HOW_TO =
  /\b(how (do|can|to|should) (i|we|you)?|comment (je|j|on|faire|puis-je|peut-on|ajouter|ouvrir|creer|supprimer|deplacer|renommer|utiliser|changer|activer|configurer|enregistrer|sauvegarder|surligner|annoter)|where (is|are) the (button|menu|option|setting)|ou (est|se trouve) (le|la) (bouton|menu|option))\b/;
const APP_NOUN =
  /\b(notetoo|bouton|button|scratchpad|sidebar|barre|menu|raccourci|shortcut|parametres?|settings|surlign\w*|highlight\w*|annot\w*|epingle|pin|dossiers?|folders?|fichiers?|files?|matieres?|subjects?|notes?|pdf|onglet|tab|theme|ia|ai)\b/;
const RULES: [Intent, RegExp][] = [
  ['highlight', /\b(surlign\w*|highlight\w*|souligne\w*)\b/],
  ['compare', /\b(compar\w*|differences?|differ\w*|versus|vs|par rapport|contrairement|similarit\w*|points? communs?)\b/],
  ['summarize', /\b(resum\w*|summar\w*|synthese|points? cles?|key points?|essentiel|en bref|tl;?dr|overview)\b/],
  ['study', /\b(revis\w*|quiz\w*|interroge\w*|flashcards?|study|memoris\w*|apprendre|teste[rz]?[- ]moi|test me)\b/],
  ['locate', /(^ou\b|\b(quelle|which|what) page\b|\bwhere\b|\b(trouve\w*|cherche\w*|locate|find|mentionne\w*)\b)/],
  ['explain', /\b(expliqu\w*|explain\w*|pourquoi|why|comment (ca|marche|fonctionne)|how (does|do|is)|c ?est quoi|qu ?est[- ]ce|what (is|are|does|do)|signifie|meaning|comprends?|understand|definition|definis?)\b/],
];

/** What the user wants from this message. */
export function detectIntent(question: string): Intent {
  const q = fold(question).replace(/[’']/g, ' ');
  if (HOW_TO.test(q) && APP_NOUN.test(q)) return 'app';
  return RULES.find(([, re]) => re.test(q))?.[0] ?? 'question';
}

/** For "surligne les définitions": what to highlight ('' = whatever matters most). */
export function highlightFocus(question: string): string {
  const rest = question
    .trim()
    .replace(/^(please\s+|peux-tu\s+|tu peux\s+)?(surligne[rz]?|souligne[rz]?|highlight|mark|marque[rz]?)(\s+(moi|me|for me|pour moi))?\s*/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  return /^(the\s+|les?\s+|ce qui est\s+)?(most\s+)?(important|importants?|importantes?|key points?|essentiel)?$/i.test(rest) ? '' : rest;
}

const THIS_DOC = /\b(ce|cet|cette) (document|fichier|cours|pdf|texte|chapitre|page|section|partie|fiche|td|tp|poly)\b|\bthis (document|file|pdf|page|section|chapter|lecture|text)\b|\b(ici|here)\b/;
const EARLIER_DOC =
  /\b(document|fichier|file|pdf|cours|chapitre|lecture)\b.{0,40}\b(precedent|d avant|tout a l heure|earlier|previous(ly)?|before|avant|ouvert)\b|\b(previous|precedent|other|autre|last|dernier) (document|fichier|file|pdf|cours)\b/;
const FOLLOW_UP = /^(et|and|also|aussi|puis|ensuite|then|what about|et pour|et si|and the|ok|d accord)\b/;

/** Words of a file's name (weight 1), of its folder (0.5) and of the folders above, such as the
 *  subject (0.25: enough to tell two "TD3/ex2.pdf" apart, never enough to pick a file alone). */
function nameWords(path: string): Map<string, number> {
  const w = new Map<string, number>();
  const folders = parentPath(path).split('/');
  for (const f of folders.slice(0, -1)) for (const t of tokens(f)) w.set(t, 0.25);
  for (const t of tokens(folders[folders.length - 1] ?? '')) w.set(t, 0.5);
  for (const t of tokens(baseName(path).replace(/\.[^.]+$/, ''))) w.set(t, 1);
  return w;
}

export interface Resolved {
  /** documents the question is about (may be empty) */
  paths: string[];
  /** several files match the name equally: ask which one */
  ambiguous?: string[];
}

export function resolveDocs(question: string, o: { current?: string; recent: string[]; index: string[]; lastDocs: string[] }): Resolved {
  const q = fold(question).replace(/[’']/g, ' ');
  const out: string[] = [];
  const add = (p?: string) => p && !out.includes(p) && out.push(p);
  const deictic = THIS_DOC.test(q);
  if (deictic) add(o.current);
  if (EARLIER_DOC.test(q)) add(o.recent.find((p) => p !== o.current));

  // Files named in the question.
  const qw = new Set(tokens(question));
  const scored = o.index
    .filter((p) => !(deictic && p === o.current))
    .map((p) => {
      let score = 0;
      let strong = false;
      for (const [w, weight] of nameWords(p)) {
        if (!qw.has(w)) continue;
        score += weight;
        if (/\d/.test(w) && /[a-z]/.test(w)) strong = true; // td3, tp1, l2…
      }
      return { p, score, ok: score >= 2 || strong };
    })
    .filter((x) => x.ok)
    .sort((a, b) => b.score - a.score);
  if (scored.length) {
    const top = scored.filter((x) => x.score === scored[0].score).map((x) => x.p);
    if (top.length > 1 && !top.includes(o.current ?? '')) return { paths: out, ambiguous: top };
    add(top.length > 1 ? o.current : top[0]);
  }
  if (out.length) return { paths: out };

  if (o.lastDocs.length && (!o.current || FOLLOW_UP.test(q) || q.length < 25)) return { paths: o.lastDocs };
  return { paths: o.current ? [o.current] : o.lastDocs };
}
