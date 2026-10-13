import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { loadPdf } from '../../lib/pdf';
import { errorMessage, isOutsideViewer } from '../../lib/ui';
import { AnnotateTools, AnnotationLayer, type AnnotationProps } from '../annotations/AnnotationLayer';
import { Spinner, cls } from '../common';

type Size = { w: number; h: number };
const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export default function PdfViewer({ file, annot }: { file: File; annot: AnnotationProps }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // ----- load (contents are only read now that the file is opened) -----
  useEffect(() => {
    let task: PDFDocumentLoadingTask | null = null;
    let cancelled = false;
    setDoc(null);
    setError(null);
    (async () => {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        task = loadPdf(data);
        const d = await task.promise;
        if (cancelled) return;
        const first = (await d.getPage(1)).getViewport({ scale: 1 });
        setSizes(Array.from({ length: d.numPages }, () => ({ w: first.width, h: first.height })));
        pageEls.current = [];
        setDoc(d);
        setPage(1);
      } catch (e) {
        if (cancelled) return;
        const name = (e as Error)?.name;
        setError(name === 'PasswordException' ? 'This PDF is password-protected and cannot be previewed.' : `Could not open this PDF: ${errorMessage(e)}`);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [file]);

  const onSize = useCallback((i: number, s: Size) => {
    setSizes((prev) => (prev[i] && Math.abs(prev[i].w - s.w) < 0.5 && Math.abs(prev[i].h - s.h) < 0.5 ? prev : prev.map((p, j) => (j === i ? s : p))));
  }, []);

  // ----- zoom -----
  const applyFit = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !sizes.length) return;
    const widest = Math.max(...sizes.slice(0, 5).map((s) => s.w));
    setScale(clampScale((el.clientWidth - 56) / widest));
  }, [sizes]);

  useEffect(() => {
    if (!fitWidth || !doc) return;
    applyFit();
    const ro = new ResizeObserver(applyFit);
    ro.observe(scrollRef.current!);
    return () => ro.disconnect();
  }, [fitWidth, doc, applyFit]);

  const zoom = useCallback((factor: number) => {
    setFitWidth(false);
    setScale((s) => clampScale(Math.round(s * factor * 100) / 100));
  }, []);

  // Keep the same spot in view when the scale changes.
  const prevScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const ratio = scale / prevScale.current;
    prevScale.current = scale;
    if (el && ratio !== 1) {
      el.scrollTop = el.scrollTop * ratio;
      el.scrollLeft = el.scrollLeft * ratio;
    }
  }, [scale]);

  // ----- navigation -----
  const goTo = useCallback(
    (n: number, behavior: ScrollBehavior = 'auto') => {
      if (!doc) return;
      const p = Math.min(doc.numPages, Math.max(1, n));
      pageEls.current[p - 1]?.scrollIntoView({ block: 'start', behavior });
      setPage(p);
    },
    [doc],
  );

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const probe = el.scrollTop + el.clientHeight * 0.3;
    let current = 1;
    for (let i = 0; i < pageEls.current.length; i++) {
      const p = pageEls.current[i];
      if (p && p.offsetTop <= probe) current = i + 1;
      else if (p) break;
    }
    setPage(current);
  };
  useEffect(() => setPageInput(String(page)), [page]);

  // ----- search -----
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [hits, setHits] = useState<{ page: number; count: number }[] | null>(null);
  const [hitIdx, setHitIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const textCache = useRef(new Map<number, string>());
  useEffect(() => {
    textCache.current = new Map();
    setHits(null);
    setActive('');
  }, [doc]);

  const runSearch = async (q: string) => {
    if (!doc) return;
    const needle = q.trim().toLowerCase();
    setActive(needle);
    if (!needle) return setHits(null);
    setSearching(true);
    const res: { page: number; count: number }[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      let text = textCache.current.get(i);
      if (text === undefined) {
        const tc = await (await doc.getPage(i)).getTextContent();
        text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').toLowerCase();
        textCache.current.set(i, text);
      }
      const count = text.split(needle).length - 1;
      if (count) res.push({ page: i, count });
    }
    setSearching(false);
    setHits(res);
    setHitIdx(0);
    if (res[0]) goTo(res[0].page);
  };
  const stepHit = (d: number) => {
    if (!hits?.length) return;
    const i = (hitIdx + d + hits.length) % hits.length;
    setHitIdx(i);
    goTo(hits[i].page);
  };

  // ----- keyboard -----
  const { setTool } = annot;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (isOutsideViewer(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === 'ArrowRight' || e.key === 'n') goTo(page + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'p') goTo(page - 1);
      else if (e.key === '+' || e.key === '=') zoom(1.2);
      else if (e.key === '-') zoom(1 / 1.2);
      else if (e.key === 'v') setTool('select');
      else if (e.key === 'h') setTool('area');
      else if (e.key === 'c') setTool('pin');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, page, zoom, setTool]);

  // ----- jump to an annotation picked in the side panel -----
  const { flash, annotations } = annot;
  useEffect(() => {
    if (!flash || !doc) return;
    const target = annotations.find((x) => x.id === flash.id) ?? annot.suggestions?.find((x) => x.id === flash.id);
    if (!target) return;
    goTo(target.page);
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector(`[data-annot-id="${CSS.escape(flash.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
  }, [flash, doc]); // only when a new jump is requested

  if (error) return <div className="empty">{error}</div>;

  return (
    <>
      <div className="toolbar">
        <div className="tool-group">
          <button className="icon-btn" aria-label="Previous page" title="Previous page (←)" onClick={() => goTo(page - 1)} disabled={page <= 1}>
            <ChevronLeft size={18} />
          </button>
          <input
            className="page-input"
            aria-label="Page number"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && goTo(Number(pageInput) || 1)}
            onBlur={() => setPageInput(String(page))}
          />
          <span className="muted">/ {doc?.numPages ?? '…'}</span>
          <button
            className="icon-btn"
            aria-label="Next page"
            title="Next page (→)"
            onClick={() => goTo(page + 1)}
            disabled={!doc || page >= doc.numPages}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="tool-group">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoom(1 / 1.2)}>
            <ZoomOut size={18} />
          </button>
          <button className="zoom-label" title="Reset to 100%" onClick={() => (setFitWidth(false), setScale(1))}>
            {Math.round(scale * 100)}%
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom(1.2)}>
            <ZoomIn size={18} />
          </button>
          <button
            className={cls('icon-btn', fitWidth && 'active')}
            aria-label="Fit to width"
            title="Fit to width"
            aria-pressed={fitWidth}
            onClick={() => setFitWidth(true)}
          >
            <MoveHorizontal size={18} />
          </button>
        </div>
        <AnnotateTools a={annot} />
        <form
          className="pdf-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (active === query.trim().toLowerCase() && hits?.length) stepHit(1);
            else void runSearch(query);
          }}
        >
          <input
            ref={searchRef}
            type="search"
            placeholder="Search in PDF (Ctrl+F)"
            aria-label="Search in this PDF"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) void runSearch('');
            }}
          />
          <span className="muted nowrap" aria-live="polite">
            {searching ? '…' : hits ? (hits.length ? `${hitIdx + 1}/${hits.length} p.` : '0') : ''}
          </span>
          <button type="button" className="icon-btn small" aria-label="Previous match" onClick={() => stepHit(-1)} disabled={!hits?.length}>
            <ChevronUp size={15} />
          </button>
          <button type="button" className="icon-btn small" aria-label="Next match" onClick={() => stepHit(1)} disabled={!hits?.length}>
            <ChevronDown size={15} />
          </button>
        </form>
      </div>
      <div
        className="pdf-scroll"
        ref={(el) => {
          scrollRef.current = el;
          setScrollEl(el);
        }}
        onScroll={onScroll}
      >
        {!doc ? (
          <Spinner label="Opening PDF…" />
        ) : (
          <div className="pdf-pages">
            {sizes.map((size, i) => (
              <div key={i} ref={(el) => void (pageEls.current[i] = el)}>
                <PdfPage
                  doc={doc}
                  num={i + 1}
                  scale={scale}
                  size={size}
                  onSize={onSize}
                  root={scrollEl}
                  query={hits?.some((h) => h.page === i + 1) ? active : ''}
                  annot={annot}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  num: number;
  scale: number;
  size: Size;
  onSize: (i: number, s: Size) => void;
  root: HTMLElement | null;
  query: string;
  annot: AnnotationProps;
}

/** One page: rendered only while near the viewport (canvas + selectable text layer). */
const PdfPage = memo(function PdfPage({ doc, num, scale, size, onSize, root, query, annot }: PdfPageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [textReady, setTextReady] = useState(0);

  useEffect(() => {
    if (!root || !ref.current) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root, rootMargin: '1200px 0px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const host = canvasHost.current!;
    const text = textRef.current!;
    if (!visible) {
      // Free memory for pages far from the viewport.
      host.replaceChildren();
      text.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    let textLayer: pdfjs.TextLayer | null = null;
    (async () => {
      const page = await doc.getPage(num);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onSize(num - 1, { w: base.width, h: base.height });
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      task = page.render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      await task.promise;
      if (cancelled) return;
      host.replaceChildren(canvas); // swap only when done: no blank flash while zooming
      const fresh = document.createElement('div');
      fresh.className = 'textLayer';
      text.replaceChildren(fresh);
      textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: fresh, viewport: vp });
      await textLayer.render();
      if (!cancelled) setTextReady((n) => n + 1);
    })().catch((e) => {
      if ((e as Error)?.name !== 'RenderingCancelledException') console.warn(`PDF page ${num}:`, e);
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [visible, scale, doc, num, onSize]);

  // Mark text-layer spans containing the search term.
  useEffect(() => {
    for (const span of textRef.current?.querySelectorAll('span') ?? []) {
      span.classList.toggle('pdf-hit', !!query && !!span.textContent?.toLowerCase().includes(query));
    }
  }, [query, textReady]);

  return (
    <div
      ref={ref}
      className="pdf-page"
      data-page={num}
      style={
        {
          width: size.w * scale,
          height: size.h * scale,
          '--scale-factor': scale,
          '--total-scale-factor': scale,
        } as React.CSSProperties
      }
    >
      <span className="pdf-page-num">{num}</span>
      <div ref={canvasHost} />
      <div ref={textRef} />
      <AnnotationLayer page={num} a={annot} />
    </div>
  );
});
