import type { Entry } from '../fs/fsService';
import { SECTIONS, type Section, joinPath, matchSection } from '../fs/paths';

export interface SectionInfo {
  subject: string;
  section: Section;
  /** real folder path (may not exist yet; created on first use) */
  dirPath: string;
  exists: boolean;
  /** for "Other": non-section folders and loose files at the subject root */
  extras: Entry[];
}

/** Maps a subject folder's children onto the five fixed sections. */
export function sectionsOf(subject: string, children: Entry[]): SectionInfo[] {
  const findDir = (s: Section) => children.find((e) => e.kind === 'dir' && matchSection(e.name) === s);
  const extras = children.filter((e) => !(e.kind === 'dir' && matchSection(e.name)));
  return SECTIONS.map((section) => {
    const dir = findDir(section);
    return {
      subject,
      section,
      dirPath: dir?.path ?? joinPath(subject, section),
      exists: !!dir,
      extras: section === 'Other' ? extras : [],
    };
  });
}
