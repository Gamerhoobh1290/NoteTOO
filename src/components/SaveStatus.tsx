import { Check, CloudAlert, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { DiskDoc } from '../state/useDiskDoc';

export function SaveIndicator({ doc }: { doc: Pick<DiskDoc<unknown>, 'status' | 'error' | 'retry'> }) {
  switch (doc.status) {
    case 'pending':
    case 'saving':
      return (
        <span className="save-state" role="status">
          <LoaderCircle size={13} className="spin" /> Saving…
        </span>
      );
    case 'saved':
      return (
        <span className="save-state saved" role="status">
          <Check size={13} /> Saved
        </span>
      );
    case 'error':
      return (
        <span className="save-state error" role="alert" title={doc.error ?? ''}>
          <TriangleAlert size={13} /> {doc.error ? 'Save failed' : 'Error'}
          <button className="link-btn" onClick={doc.retry}>
            Retry
          </button>
        </span>
      );
    case 'conflict':
      return (
        <span className="save-state conflict" role="alert">
          <CloudAlert size={13} /> Changed on disk
        </span>
      );
    default:
      return null;
  }
}

/** Asks whether to take the disk version or keep ours, instead of silently overwriting. */
export function ConflictBanner({ doc, what }: { doc: Pick<DiskDoc<unknown>, 'status' | 'resolve'>; what: string }) {
  if (doc.status !== 'conflict') return null;
  return (
    <div className="notice notice-warn" role="alert">
      <span>
        {what} was changed outside NoteTOO (for example by your drive sync) since it was opened. Your latest edits are not
        saved yet.
      </span>
      <span className="row-actions">
        <button className="btn small" onClick={() => doc.resolve('reload')}>
          Reload from disk (discard my edits)
        </button>
        <button className="btn small danger-outline" onClick={() => doc.resolve('overwrite')}>
          Overwrite with my version
        </button>
      </span>
    </div>
  );
}
