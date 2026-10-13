// Turns the model's "this file belongs at <path>" answers into a safe, reviewable plan.
// Pure (unit-tested): every target is validated here before the user even sees it.

import { baseName, extName, joinPath, matchSection, parentPath, splitPath, validateName, withSuffix } from '../fs/paths';
import { InvalidAnswer, arrayField, isObj } from './json';

export interface Proposal {
  id: number;
  target: string;
  reason: string;
}

export interface PlannedChange {
  from: string;
  to: string;
  reason: string;
  move: boolean;
  rename: boolean;
}

export interface Plan {
  changes: PlannedChange[];
  /** folders that applying all changes would create (outermost first) */
  newFolders: string[];
  rejected: { from: string; target: string; why: string }[];
}

export const ORGANIZE_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, target: { type: 'string' }, reason: { type: 'string' } },
        required: ['id', 'target', 'reason'],
      },
    },
  },
  required: ['files'],
};

/** Validator for askJson: shape only; the paths are checked by planChanges. */
export function parseProposals(v: unknown): Proposal[] {
  return arrayField(v, 'files').map((f, i) => {
    if (!isObj(f) || typeof f.id !== 'number' || typeof f.target !== 'string') {
      throw new InvalidAnswer(`files[${i}] must have a numeric "id" and a string "target".`);
    }
    return { id: f.id, target: f.target, reason: typeof f.reason === 'string' ? f.reason.trim() : '' };
  });
}

const lower = (p: string) => p.toLowerCase();

/**
 * @param files   the files that were shown to the model, by id
 * @param existing every existing file and folder path under the root (for casing and collisions)
 */
export function planChanges(
  files: Map<number, string>,
  proposals: Proposal[],
  existing: { path: string; kind: 'file' | 'dir' }[],
): Plan {
  const dirs = new Map<string, string>(); // lower-case path -> real path
  const taken = new Set<string>(); // lower-case paths of files (current + planned)
  for (const e of existing) (e.kind === 'dir' ? dirs.set(lower(e.path), e.path) : taken.add(lower(e.path)));

  const plan: Plan = { changes: [], newFolders: [], rejected: [] };
  const seen = new Set<number>();

  for (const p of proposals) {
    const from = files.get(p.id);
    if (!from || seen.has(p.id)) continue;
    seen.add(p.id);
    const reject = (why: string) => plan.rejected.push({ from, target: p.target, why });

    const segs = splitPath(p.target.trim().replace(/\\/g, '/'));
    if (segs.join('/') === from) continue; // "leave it where it is"
    if (segs.length < 3) {
      reject('The destination must be Subject/Section/…/file name.');
      continue;
    }
    const bad = segs.map((s) => validateName(s)).find(Boolean);
    if (bad || segs.some((s) => s.startsWith('.'))) {
      reject(bad ?? 'Hidden folders are not allowed.');
      continue;
    }

    // Reuse the real casing of existing folders; sections may be spelled "cours" on disk.
    const real: string[] = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const parent = real.join('/');
      let seg = segs[i];
      if (i === 1) {
        const sec = matchSection(seg);
        if (!sec) {
          reject(`"${seg}" is not a section (Cours, TD, TP, Exams or Other).`);
          break;
        }
        const onDisk = [...dirs.values()].find((d) => parentPath(d) === parent && matchSection(baseName(d)) === sec);
        seg = onDisk ? baseName(onDisk) : sec;
      } else {
        const onDisk = dirs.get(lower(joinPath(parent, seg)));
        if (onDisk) seg = baseName(onDisk);
      }
      real.push(seg);
    }
    if (real.length !== segs.length - 1) continue;

    // Keep the original extension: renaming must never change a file's type.
    let name = segs[segs.length - 1];
    const ext = extName(baseName(from));
    if (extName(name) !== ext) {
      const stem = extName(name) && name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name;
      name = ext ? `${stem}.${ext}` : stem;
    }
    const dir = real.join('/');
    let to = joinPath(dir, name);
    if (to === from) continue;

    if (lower(to) !== lower(from)) {
      for (let n = 1; taken.has(lower(to)); n++) to = joinPath(dir, withSuffix(name, n));
    }
    taken.delete(lower(from));
    taken.add(lower(to));

    for (let i = 1; i <= real.length; i++) {
      const d = real.slice(0, i).join('/');
      if (!dirs.has(lower(d))) {
        dirs.set(lower(d), d); // later proposals reuse this spelling
        plan.newFolders.push(d);
      }
    }
    plan.changes.push({
      from,
      to,
      reason: p.reason,
      move: lower(parentPath(from)) !== lower(dir),
      rename: baseName(from) !== baseName(to),
    });
  }
  return plan;
}
