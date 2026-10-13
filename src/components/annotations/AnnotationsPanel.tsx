import { useEffect, useState } from 'react';
import { Check, MapPin, MessageSquare, Sparkles, Square, Trash2, X } from 'lucide-react';
import { AI_COLOR, COLORS, newId, type Annotation, type Color, type Sidecar } from '../../fs/sidecar';
import type { Suggestion } from '../../state/AiContext';
import { formatDate } from '../../lib/fileKinds';
import { confirmDialog } from '../../lib/ui';
import type { DiskDoc } from '../../state/useDiskDoc';
import { ConflictBanner, SaveIndicator } from '../SaveStatus';
import { Spinner, cls } from '../common';

const now = () => new Date().toISOString();
const position = (a: Annotation) => (a.type === 'area' ? a.rect.y : a.point.y);
/** Colors offered for an annotation: the user's four, plus purple on highlights kept from the AI. */
const pickable = (c: Color): readonly Color[] => (c === AI_COLOR ? [...COLORS, AI_COLOR] : COLORS);

interface Props {
  doc: DiskDoc<Sidecar>;
  areas: boolean;
  selectedId: string | null;
  focusId: string | null;
  onJump: (id: string) => void;
  onClose: () => void;
  /** AI highlight suggestions for this file, waiting for review */
  suggestions?: Suggestion[];
  onReviewSuggestions?: (ids: string[], keep: boolean) => void;
}

export function AnnotationsPanel({ doc, areas, selectedId, focusId, onJump, onClose, suggestions, onReviewSuggestions }: Props) {
  const s = doc.value;
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (selectedId) document.querySelector(`[data-panel-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);
  useEffect(() => {
    if (focusId) document.querySelector<HTMLTextAreaElement>(`[data-panel-id="${CSS.escape(focusId)}"] textarea`)?.focus();
  }, [focusId]);

  const patch = (id: string, p: Partial<Annotation>) =>
    doc.update((sc) => ({ ...sc, annotations: sc.annotations.map((a) => (a.id === id ? ({ ...a, ...p, updatedAt: now() } as Annotation) : a)) }));
  const remove = async (a: Annotation) => {
    const ok = await confirmDialog({
      title: `Delete this ${a.type === 'area' ? 'highlight' : 'comment pin'}?`,
      message: a.comment ? `Its comment “${a.comment.slice(0, 120)}” will be deleted too.` : 'It will be removed from this file’s annotations.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) doc.update((sc) => ({ ...sc, annotations: sc.annotations.filter((x) => x.id !== a.id) }));
  };
  const addComment = () => {
    const text = draft.trim();
    if (!text) return;
    doc.update((sc) => ({ ...sc, fileComments: [...sc.fileComments, { id: newId(), text, createdAt: now() }] }));
    setDraft('');
  };
  const editComment = (id: string, text: string) =>
    doc.update((sc) => ({ ...sc, fileComments: sc.fileComments.map((c) => (c.id === id ? { ...c, text, updatedAt: now() } : c)) }));
  const removeComment = async (id: string) => {
    if (await confirmDialog({ title: 'Delete this comment?', message: 'This file comment will be deleted.', confirmLabel: 'Delete', danger: true })) {
      doc.update((sc) => ({ ...sc, fileComments: sc.fileComments.filter((c) => c.id !== id) }));
    }
  };

  const sorted = s ? [...s.annotations].sort((a, b) => a.page - b.page || position(a) - position(b)) : [];

  return (
    <aside className="panel" aria-label="Annotations and comments">
      <div className="panel-head">
        <h2>Annotations</h2>
        <SaveIndicator doc={doc} />
        <button className="icon-btn small" aria-label="Close panel" title="Close (Alt+2)" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <ConflictBanner doc={doc} what="This file's annotations file" />
      {!s ? (
        doc.status === 'error' ? (
          <div className="empty">
            <p>Could not load annotations: {doc.error}</p>
            <button className="btn" onClick={doc.retry}>
              Retry
            </button>
          </div>
        ) : (
          <Spinner />
        )
      ) : (
        <div className="panel-body">
          {!!suggestions?.length && onReviewSuggestions && (
            <section className="panel-section ai-suggestions">
              <h3>
                <Sparkles size={12} /> Suggested by AI ({suggestions.length})
              </h3>
              <div className="row-actions">
                <button className="btn small" onClick={() => onReviewSuggestions(suggestions.map((x) => x.id), true)}>
                  <Check size={14} /> Keep all
                </button>
                <button className="btn small" onClick={() => onReviewSuggestions(suggestions.map((x) => x.id), false)}>
                  <X size={14} /> Discard all
                </button>
              </div>
              <ul className="annot-list">
                {[...suggestions]
                  .sort((a, b) => a.page - b.page || a.rect.y - b.rect.y)
                  .map((x) => (
                    <li key={x.id} data-panel-id={x.id} className={cls('annot-item c-purple ai-suggestion-item', selectedId === x.id && 'selected')}>
                      <div className="annot-item-head">
                        <button className="goto" onClick={() => onJump(x.id)} title="Show on the page">
                          <Sparkles size={13} /> Suggestion · page {x.page}
                        </button>
                        <button className="icon-btn small" aria-label="Keep this highlight" title="Keep" onClick={() => onReviewSuggestions([x.id], true)}>
                          <Check size={15} />
                        </button>
                        <button className="icon-btn small" aria-label="Discard this suggestion" title="Discard" onClick={() => onReviewSuggestions([x.id], false)}>
                          <X size={15} />
                        </button>
                      </div>
                      <p className="ai-why">{x.why}</p>
                    </li>
                  ))}
              </ul>
            </section>
          )}
          {areas && (
            <section className="panel-section">
              <h3>Highlights & pins ({sorted.length})</h3>
              {!sorted.length && (
                <p className="muted hint">
                  Pick <Square size={12} /> to highlight an area (drag a rectangle), or <MapPin size={12} /> to drop a comment
                  pin. Then write your comment here.
                </p>
              )}
              <ul className="annot-list">
                {sorted.map((a) => (
                  <li key={a.id} data-panel-id={a.id} className={cls('annot-item', `c-${a.color}`, selectedId === a.id && 'selected')}>
                    <div className="annot-item-head">
                      <button className="goto" onClick={() => onJump(a.id)} title="Show on the page">
                        {a.type === 'area' ? <Square size={13} /> : <MapPin size={13} />}
                        {a.type === 'area' ? 'Highlight' : 'Pin'} · page {a.page}
                      </button>
                      <span className="annot-colors" role="radiogroup" aria-label="Color">
                        {pickable(a.color).map((c) => (
                          <button
                            key={c}
                            role="radio"
                            aria-checked={a.color === c}
                            aria-label={c}
                            title={c}
                            className={cls('swatch', `swatch-${c}`, a.color === c && 'on')}
                            onClick={() => patch(a.id, { color: c })}
                          />
                        ))}
                      </span>
                      <button className="icon-btn small" aria-label="Delete annotation" title="Delete" onClick={() => remove(a)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <textarea
                      aria-label="Comment"
                      placeholder="Add a comment…"
                      value={a.comment}
                      rows={2}
                      onChange={(e) => patch(a.id, { comment: e.target.value })}
                      onFocus={() => selectedId !== a.id && onJump(a.id)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel-section">
            <h3>
              <MessageSquare size={12} /> File comments ({s.fileComments.length})
            </h3>
            <ul className="annot-list">
              {s.fileComments.map((c) => (
                <li key={c.id} className="annot-item">
                  <div className="annot-item-head">
                    <span className="comment-meta" style={{ flex: 1 }}>
                      {formatDate(c.createdAt)}
                      {c.updatedAt && c.updatedAt !== c.createdAt ? ' · edited' : ''}
                    </span>
                    <button className="icon-btn small" aria-label="Delete comment" title="Delete" onClick={() => removeComment(c.id)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea aria-label="File comment" value={c.text} rows={2} onChange={(e) => editComment(c.id, e.target.value)} />
                </li>
              ))}
            </ul>
            <div className="comment-new">
              <textarea
                aria-label="New file comment"
                placeholder="Write a note about this file…"
                value={draft}
                rows={3}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment();
                }}
              />
              <button className="btn small primary" style={{ justifySelf: 'end' }} onClick={addComment} disabled={!draft.trim()}>
                Add comment
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
