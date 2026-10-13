// Generates ./sample-school, a throwaway folder for testing NoteTOO.
// Usage: npm run sample            (refuses if the folder exists)
//        npm run sample -- --force (deletes and regenerates ./sample-school only)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as XLSX from 'xlsx';

const ROOT = resolve(import.meta.dirname, '..', 'sample-school');

if (existsSync(ROOT)) {
  if (!process.argv.includes('--force')) {
    console.error(`${ROOT} already exists. Use "npm run sample -- --force" to regenerate it.`);
    process.exit(1);
  }
  rmSync(ROOT, { recursive: true });
}

function put(path, data) {
  const full = join(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
}
const dir = (path) => mkdirSync(join(ROOT, path), { recursive: true });

// ---------- PDF ----------
async function pdf(title, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(title, { x: 50, y: 780, size: 20, font: bold });
    page.drawText(`Page ${i} / ${pages}`, { x: 50, y: 750, size: 12, font, color: rgb(0.4, 0.4, 0.4) });
    const lines = [
      `Section ${i}.1 - Définitions et propriétés`,
      'Soit f une fonction continue sur [a, b]. On définit son intégrale',
      'comme la limite des sommes de Riemann lorsque le pas tend vers zéro.',
      `Théorème ${i}: toute fonction continue sur un segment est intégrable.`,
      'Exercice: calculer l\'intégrale de x^2 entre 0 et 1. Réponse: 1/3.',
      'Remarque: les graphes orientés seront vus en TD3.',
    ];
    lines.forEach((t, j) => page.drawText(t, { x: 50, y: 700 - j * 24, size: 13, font }));
    page.drawRectangle({ x: 50, y: 380, width: 495, height: 140, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1.5 });
    page.drawText('Formule: F(b) - F(a)', { x: 70, y: 450, size: 18, font: bold, color: rgb(0.2, 0.4, 0.8) });
  }
  return doc.save();
}

// ---------- PNG (hand-written encoder) ----------
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const inCircle = (x - w / 2) ** 2 + (y - h / 2) ** 2 < (h / 4) ** 2;
      raw[i] = inCircle ? 240 : Math.round((x / w) * 120 + 60);
      raw[i + 1] = inCircle ? 180 : Math.round((y / h) * 120 + 80);
      raw[i + 2] = inCircle ? 40 : 200;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- DOCX (minimal package) ----------
async function docx(paragraphs) {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const body = paragraphs
    .map(([style, text]) =>
      style === 'b'
        ? `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`
        : style === 'h'
          ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`
          : `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`,
    )
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---------- WAV ----------
function wav(seconds = 3, freq = 440, rate = 22050) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

function ffmpeg(args, label) {
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
    return true;
  } catch {
    console.warn(`  (skipped ${label}: ffmpeg unavailable or codec missing)`);
    return false;
  }
}

// ---------- build ----------
console.log(`Writing ${ROOT}`);
for (const s of ['Maths', 'Physique', 'Informatique', 'Économie & Société']) {
  for (const sec of ['Cours', 'TD', 'TP', 'Exams', 'Other']) dir(`${s}/${sec}`);
}

put('Maths/Cours/Chapitre 1 - Intégrales.pdf', await pdf('Chapitre 1 - Intégrales', 40));
put('Maths/TD/TD3 - Graphes/ex2.pdf', await pdf('TD3 - Exercice 2 (Maths)', 3));
put('Maths/TD/TD3 - Graphes/Sous-dossier/notes.txt', 'Un fichier imbriqué dans un sous-dossier.\n');
put('Maths/Exams/Examen 2025.pdf', await pdf('Examen final 2025', 4));
put('Maths/Cours/schéma.png', png(640, 400));
put('Maths/Projet/rapport.md', '# Rapport de projet\n\nUn dossier hors sections : il apparaît sous **Other**.\n\n- [x] Introduction\n- [ ] Conclusion\n');
put('Maths/loose file.txt', 'Fichier directement dans le dossier du sujet.\n');
put('Maths/desktop.ini', '[.ShellClassInfo]\n');
put('Maths/_notes.md', '# Maths — notes\n\n- Revoir les **intégrales**\n- [ ] Finir TD3\n- [x] Rendre TP1\n');

put('Physique/TD/TD3/ex2.pdf', await pdf('TD3 - Exercice 2 (Physique)', 2));
put(
  'Physique/Cours/circuit.svg',
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><rect width="400" height="240" fill="#f7f7f2"/><path d="M40 120 H140 M260 120 H360 M140 80 V160 M260 80 V160" stroke="#225" stroke-width="4" fill="none"/><rect x="170" y="100" width="60" height="40" fill="none" stroke="#c33" stroke-width="4"/><text x="200" y="200" text-anchor="middle" font-family="sans-serif" font-size="18">R = 10 Ω</text></svg>',
);
put('Physique/TP/mesures.csv', 'Tension (V);Courant (mA);Résistance (Ω)\n1;0.1;10000\n2;0.2;10000\n5;0.5;10000\n');
put(
  'Physique/Cours/Chapitre 2 - Électricité.docx',
  await docx([
    ['h', 'Chapitre 2 – Électricité'],
    ['p', 'La loi d’Ohm relie la tension, l’intensité et la résistance : U = R × I.'],
    ['b', 'À retenir : la puissance P = U × I.'],
    ['p', 'Les dipôles en série partagent la même intensité.'],
  ]),
);
put('Physique/Other/bip.wav', wav());

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Étudiant', 'TP1', 'TP2', 'Moyenne'], ['Alice', 14, 16, 15], ['Bob', 12, 13, 12.5], ['Chloé', 17, 18, 17.5]]), 'Notes');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Semaine', 'Sujet'], [1, 'Introduction'], [2, 'Boucles'], [3, 'Récursivité']]), 'Planning');
put('Informatique/TP/notes TP.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
put('Informatique/TP/tp1.py', 'def fib(n: int) -> int:\n    """Suite de Fibonacci."""\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\n\nif __name__ == "__main__":\n    print([fib(i) for i in range(10)])\n');
put('Informatique/TP/main.c', '#include <stdio.h>\n\nint main(void) {\n    for (int i = 0; i < 3; i++) {\n        printf("Bonjour %d\\n", i);\n    }\n    return 0;\n}\n');
put('Informatique/TD/Graph.java', 'import java.util.*;\n\npublic class Graph {\n    private final Map<Integer, List<Integer>> adj = new HashMap<>();\n\n    public void addEdge(int a, int b) {\n        adj.computeIfAbsent(a, k -> new ArrayList<>()).add(b);\n    }\n}\n');
put('Informatique/TD/requete.sql', '-- Étudiants ayant la moyenne\nSELECT nom, AVG(note) AS moyenne\nFROM notes\nGROUP BY nom\nHAVING AVG(note) >= 10;\n');
put('Informatique/Cours/config.json', JSON.stringify({ cours: 'Algorithmique', semestre: 2, chapitres: ['Tri', 'Graphes'] }, null, 2));
put('Informatique/Cours/README.md', '# Algorithmique\n\n## Plan\n\n1. Tris\n2. Graphes\n\n```python\nprint("hello")\n```\n\n| Chapitre | Heures |\n|---|---|\n| Tris | 4 |\n| Graphes | 6 |\n');
put('Informatique/Other/archive.zip', await new JSZip().file('a.txt', 'a').generateAsync({ type: 'nodebuffer' }));

const video = join(ROOT, 'Informatique/Cours/demo.mp4');
if (!ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], 'mp4')) {
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=25', '-c:v', 'libvpx', join(ROOT, 'Informatique/Cours/demo.webm')], 'webm');
}
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'libmp3lame', join(ROOT, 'Physique/Other/cours audio.mp3')], 'mp3');

// A subject with loose, unsorted files (they show up in its "To sort" tray).
put('Économie & Société/Other/Typologie et fonctions de l’entreprise.pdf', await pdf('Typologie et fonctions de l’entreprise', 6));
put('Économie & Société/Other/Typologie et fonctions de l’entreprise.pptx', await new JSZip().file('ppt/slide1.xml', '<x/>').generateAsync({ type: 'nodebuffer' }));
for (const logo of ['Renault.png', 'danone.png', 'LOreal.png', 'Logo_TotalEnergies.png']) put(`Économie & Société/Other/${logo}`, png(320, 200));
put('Économie & Société/Emmaüs_Solidarité.png', png(320, 200));
put('Économie & Société/TD/TD1 - Typologie/Exercices typologie.pdf', await pdf('TD1 - Exercices de typologie', 2));
dir('Économie & Société/TD/TD2 - Études de cas');

put('_scratchpad.md', '# Scratchpad\n\nIdées rapides…\n');

const now = new Date().toISOString();
put(
  '.noteTOO/Maths/Cours/Chapitre 1 - Intégrales.pdf.annotations.json',
  JSON.stringify(
    {
      version: 1,
      file: 'Maths/Cours/Chapitre 1 - Intégrales.pdf',
      fileComments: [{ id: 'c-1', text: 'Chapitre important pour l’examen.', createdAt: now }],
      annotations: [
        { id: 'a-1', type: 'area', page: 1, rect: { x: 0.08, y: 0.42, w: 0.84, h: 0.18 }, color: 'yellow', comment: 'Check this formula', createdAt: now, updatedAt: now },
        { id: 'a-2', type: 'pin', page: 3, point: { x: 0.6, y: 0.2 }, color: 'pink', comment: 'Question pour le prof', createdAt: now, updatedAt: now },
      ],
    },
    null,
    2,
  ),
);
put('.noteTOO/Maths/Exams/Examen 2025.pdf.annotations.json', '{ this is not valid json');

console.log('Done.');
