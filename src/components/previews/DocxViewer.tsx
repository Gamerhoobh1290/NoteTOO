import { useEffect, useState } from 'react';
import { errorMessage } from '../../lib/ui';
import { Spinner } from '../common';

/** mammoth emits a small tag set, but the .docx comes from outside: strip anything active. */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcset') el.removeAttribute(attr.name);
    }
    if (el.tagName === 'A') {
      const href = el.getAttribute('href') ?? '';
      if (!/^(https?:|mailto:|#)/i.test(href)) el.removeAttribute('href');
      else if (!href.startsWith('#')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
    }
    if (el.tagName === 'IMG' && !/^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(el.getAttribute('src') ?? '')) el.remove();
  });
  return doc.body.innerHTML;
}

export default function DocxViewer({ file }: { file: File }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    (async () => {
      try {
        const mammoth = (await import('mammoth')).default;
        const res = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
        if (!cancelled) setHtml(sanitize(res.value));
      } catch (e) {
        if (!cancelled) setError(`Could not read this document: ${errorMessage(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  if (error) return <div className="empty">{error}</div>;
  return (
    <>
      <div className="notice">Read-only preview. Formatting is simplified (fonts, colors, page layout and some elements are not shown).</div>
      <div className="doc-scroll">
        {html === null ? (
          <Spinner label="Converting document…" />
        ) : html.trim() ? (
          <article className="docx-body markdown" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="empty">This document has no readable text.</div>
        )}
      </div>
    </>
  );
}
