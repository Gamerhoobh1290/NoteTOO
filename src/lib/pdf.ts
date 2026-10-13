// Opens PDFs with pdf.js, shared by the viewer and the AI text extraction.
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** Starts loading a PDF; font/cmap/wasm data is served with the app (no CDN). */
export function loadPdf(data: Uint8Array): PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data,
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
}
