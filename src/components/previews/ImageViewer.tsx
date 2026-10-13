import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { extName } from '../../fs/paths';
import { isOutsideViewer } from '../../lib/ui';
import { AnnotateTools, AnnotationLayer, type AnnotationProps } from '../annotations/AnnotationLayer';
import { Spinner, cls, useObjectUrl } from '../common';

type View = { s: number; x: number; y: number };
const clamp = (s: number) => Math.min(20, Math.max(0.05, s));

export default function ImageViewer({ file, annot }: { file: File; annot: AnnotationProps }) {
  // SVG only renders in <img> with the right MIME type; files without one get it from the extension.
  const typed = useMemo(
    () => (extName(file.name) === 'svg' && file.type !== 'image/svg+xml' ? new Blob([file], { type: 'image/svg+xml' }) : file),
    [file],
  );
  const url = useObjectUrl(typed);
  const stageRef = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // "Fit" stays active (and follows window resizes) until the user zooms or pans.
  const [autoFit, setAutoFit] = useState(true);
  const fit = useCallback(() => {
    const st = stageRef.current;
    if (!st || !nat) return;
    setAutoFit(true);
    const r = st.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = clamp(Math.min((r.width - 32) / nat.w, (r.height - 32) / nat.h, 1));
    setView({ s, x: (r.width - nat.w * s) / 2, y: (r.height - nat.h * s) / 2 });
  }, [nat]);
  useEffect(() => {
    if (!autoFit || !stageRef.current) return;
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [autoFit, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setAutoFit(false);
    const r = stageRef.current!.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    setView((v) => {
      const s = clamp(v.s * factor);
      return { s, x: px - (px - v.x) * (s / v.s), y: py - (py - v.y) * (s / v.s) };
    });
  }, []);

  // Wheel zoom around the cursor (non-passive so the page does not scroll).
  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = st.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    return () => st.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const { setTool } = annot;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isOutsideViewer(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.key === '+' || e.key === '=') zoomAt(1.2);
      else if (e.key === '-') zoomAt(1 / 1.2);
      else if (e.key === '0') fit();
      else if (e.key === 'v') setTool('select');
      else if (e.key === 'h') setTool('area');
      else if (e.key === 'c') setTool('pin');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomAt, fit, setTool]);

  if (failed) return <div className="empty">This image could not be displayed (the format may not be supported by the browser).</div>;

  return (
    <>
      <div className="toolbar">
        <div className="tool-group">
          <button className="icon-btn" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt(1 / 1.2)}>
            <ZoomOut size={18} />
          </button>
          <button className="zoom-label" title="Actual size" onClick={() => zoomAt(1 / view.s)}>
            {Math.round(view.s * 100)}%
          </button>
          <button className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt(1.2)}>
            <ZoomIn size={18} />
          </button>
          <button className="icon-btn" aria-label="Fit to window" title="Fit (0)" onClick={fit}>
            <Maximize size={17} />
          </button>
        </div>
        <AnnotateTools a={annot} />
        <span className="muted hint">{nat ? `${nat.w} × ${nat.h}px · scroll to zoom, drag to pan` : ''}</span>
      </div>
      <div
        ref={stageRef}
        className={cls('img-stage', annot.tool === 'select' && 'panning')}
        onPointerDown={(e) => {
          if (annot.tool !== 'select' || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setAutoFit(false);
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {!url ? (
          <Spinner />
        ) : (
          <div
            className="img-canvas"
            style={
              {
                width: nat?.w ?? 0,
                height: nat?.h ?? 0,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                visibility: nat ? 'visible' : 'hidden',
                '--inv-scale': 1 / view.s,
              } as React.CSSProperties
            }
          >
            <img
              src={url}
              alt={file.name}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNat({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
              }}
              onError={() => setFailed(true)}
            />
            {nat && <AnnotationLayer page={1} a={annot} />}
          </div>
        )}
      </div>
    </>
  );
}
