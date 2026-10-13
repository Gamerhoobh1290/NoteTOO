import { SCRATCHPAD, SUBJECT_NOTES, baseName, classify, joinPath } from '../fs/paths';
import type { View } from '../state/AppContext';

/** The place the AI panel is "about", derived from the current view. */
export interface AiPlace {
  kind: 'file' | 'subject' | 'home';
  path?: string;
  subject?: string;
  label: string;
}

export function placeOf(v: View): AiPlace {
  if (v.kind === 'file') return { kind: 'file', path: v.path, subject: classify(v.path)?.subject, label: baseName(v.path) };
  if (v.kind === 'subject' || v.kind === 'notes') return { kind: 'subject', subject: v.subject, label: v.subject };
  return { kind: 'home', label: 'Whole folder' };
}

/** Where "Save to notes" goes: the subject's notes, or the scratchpad. */
export const notesFor = (subject?: string) => (subject ? joinPath(subject, SUBJECT_NOTES) : SCRATCHPAD);
