// DEV ONLY (`npm run dev`, URL `?sample`): loads ./sample-school into an in-memory folder,
// so the app can be exercised without the OS folder picker. Edits stay in memory.
// Only imported behind `import.meta.env.DEV`, so it is not part of production builds.

import { createMemoryRoot, putFile } from './memoryFs';

export async function loadSampleRoot(): Promise<FileSystemDirectoryHandle> {
  const res = await fetch('/__sample/manifest');
  if (!res.ok) throw new Error(await res.text());
  const manifest: { name: string; files: { path: string; lastModified: number }[]; dirs: string[] } = await res.json();
  const root = createMemoryRoot(manifest.name);
  for (const d of manifest.dirs) {
    let dir = root;
    for (const seg of d.split('/')) dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  await Promise.all(
    manifest.files.map(async (f) => {
      const blob = await (await fetch(`/__sample/file?path=${encodeURIComponent(f.path)}`)).blob();
      await putFile(root, f.path, blob, Math.round(f.lastModified));
    }),
  );
  // Handle for simulating "changed outside the app" (e.g. drive sync) from the dev console.
  (window as unknown as { __sampleRoot: FileSystemDirectoryHandle }).__sampleRoot = root;
  return root;
}
