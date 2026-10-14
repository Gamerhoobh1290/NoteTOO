import { useRef, useState } from 'react';
import { MapPin, MousePointer2, Square } from 'lucide-react';
import { COLORS, type Annotation, type Color, type Point, type Rect } from '../../fs/sidecar';
import type { Suggestion } from '../../state/AiContext';
import { cls } from '../common';

export type Tool = 'select' | 'area' | 'pin';
export type NewShape = { type: 'area'; page: number; rect: Rect } | { type: 'pin'; page: number; point: Point };

/** What the PDF and image viewers need to show and create annotations. */
export interface AnnotationProps {
  annotations: Annotation[];
  tool: Tool;
  color: Color;
  selectedId: string | null;
  /** bump `n` to flash the same annotation again */
  flash: { id: string; n: number } | null;
  setTool: (t: Tool) => void;
  setColor: (c: Color) => void;
  onCreate: (shape: NewShape) => void;
  onSelect: (id: string) => void;
  /** AI highlight suggestions waiting for Keep / Discard */
  suggestions?: Suggestion[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const box = (r: Rect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });

/**
 * Overlay positioned over one page/image. Everything is in percent of the page, so it
 * stays aligned at any zoom level.
 */
export function AnnotationLayer({ page, a }: { page: number; a: AnnotationProps }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<Rect | null>(null);
  const drawing = a.tool !== 'select';

  const norm = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
  };
  const rectFrom = (p: Point, q: Point): Rect => ({
    x: Math.min(p.x, q.x),
    y: Math.min(p.y, q.y),
    w: Math.abs(p.x - q.x),
    h: Math.abs(p.y - q.y),
  });

  return (
    <div
      ref={ref}
      className={cls('annot-layer', drawing && 'drawing')}
      onPointerDown={(e) => {
        if (!drawing || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const p = norm(e);
        if (a.tool === 'pin') return a.onCreate({ type: 'pin', page, point: p });
        e.currentTarget.setPointerCapture(e.pointerId);
        setStart(p);
        setDraft({ ...p, w: 0, h: 0 });
      }}
      onPointerMove={(e) => start && setDraft(rectFrom(start, norm(e)))}
      onPointerUp={(e) => {
        if (!start) return;
        const r = rectFrom(start, norm(e));
        setStart(null);
        setDraft(null);
        if (r.w > 0.005 && r.h > 0.003) a.onCreate({ type: 'area', page, rect: r });
      }}
      onPointerCancel={() => {
        setStart(null);
        setDraft(null);
      }}
    >
      {a.annotations
        .filter((x) => x.page === page)
        .map((x) => {
          const flashing = a.flash?.id === x.id;
          const common = {
            'data-annot-id': x.id,
            title: x.comment || (x.type === 'area' ? 'Highlight' : 'Comment pin'),
            onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
            onClick: (e: React.MouseEvent) => {
              e.stopPropagation();
              a.onSelect(x.id);
            },
          };
          return x.type === 'area' ? (
            // A text highlight is drawn line by line; an area highlight is one box.
            (x.rects ?? [x.rect]).map((r, i) => (
              <div
                key={x.id + i + (flashing ? `-${a.flash!.n}` : '')}
                {...common}
                className={cls('annot-area', x.color, a.selectedId === x.id && 'selected', flashing && 'flash')}
                style={box(r)}
              />
            ))
          ) : (
            <button
              key={x.id + (flashing ? `-${a.flash!.n}` : '')}
              {...common}
              aria-label={`Comment pin: ${x.comment || 'no text'}`}
              className={cls('annot-pin', x.color, a.selectedId === x.id && 'selected', flashing && 'flash')}
              style={{ left: `${x.point.x * 100}%`, top: `${x.point.y * 100}%` }}
            >
              <MapPin size={24} />
            </button>
          );
        })}
      {a.suggestions
        ?.filter((x) => x.page === page)
        .map((x) => {
          const flashing = a.flash?.id === x.id;
          return x.rects.map((r, i) => (
            <div
              key={x.id + i + (flashing ? `-${a.flash!.n}` : '')}
              data-annot-id={x.id}
              title={`AI suggestion: ${x.why}`}
              className={cls('annot-area ai-suggestion', a.selectedId === x.id && 'selected', flashing && 'flash')}
              style={box(r)}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                a.onSelect(x.id);
              }}
            />
          ));
        })}
      {draft && (
        <div
          className={cls('annot-draft', a.color)}
          style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}
        />
      )}
    </div>
  );
}

/** Tool and color pickers shown in the PDF/image toolbars. */
export function AnnotateTools({ a }: { a: AnnotationProps }) {
  const tools: [Tool, string, typeof Square][] = [
    ['select', 'Select / pan (V)', MousePointer2],
    ['area', 'Highlight an area (H)', Square],
    ['pin', 'Add a comment pin (C)', MapPin],
  ];
  const tour: Partial<Record<Tool, string>> = { area: 'tool-area', pin: 'tool-pin' };
  return (
    <>
      <div className="tool-group" role="radiogroup" aria-label="Annotation tool">
        {tools.map(([t, label, Icon]) => (
          <button
            key={t}
            role="radio"
            aria-checked={a.tool === t}
            data-tour={tour[t]}
            className={cls('icon-btn', a.tool === t && 'active')}
            title={label}
            aria-label={label}
            onClick={() => a.setTool(t)}
          >
            <Icon size={17} />
          </button>
        ))}
      </div>
      <div className="tool-group" role="radiogroup" aria-label="Highlight color">
        {COLORS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={a.color === c}
            aria-label={c}
            title={c}
            className={cls('swatch', `swatch-${c}`, a.color === c && 'on')}
            onClick={() => a.setColor(c)}
          />
        ))}
      </div>
    </>
  );
}
