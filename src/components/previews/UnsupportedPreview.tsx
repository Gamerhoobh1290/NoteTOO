import { ExternalLink, FileQuestion, FolderSearch } from 'lucide-react';
import { extName } from '../../fs/paths';
import { formatDate, formatSize } from '../../lib/fileKinds';
import { useApp } from '../../state/AppContext';

export default function UnsupportedPreview({ file, path, rootName, reason }: { file: File; path: string; rootName: string; reason?: string }) {
  const app = useApp();
  const openInTab = () => {
    const url = URL.createObjectURL(file);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  return (
    <div className="empty">
      <div className="info-card">
        <FileQuestion size={40} aria-hidden className="muted" />
        <h2>{file.name}</h2>
        <p className="muted">{reason ?? 'No preview available for this type of file.'}</p>
        <dl className="file-info">
          <dt>Type</dt>
          <dd>{extName(file.name).toUpperCase() || 'Unknown'}</dd>
          <dt>Size</dt>
          <dd>{formatSize(file.size)}</dd>
          <dt>Modified</dt>
          <dd>{formatDate(file.lastModified)}</dd>
          <dt>Location</dt>
          <dd className="break">
            {rootName}/{path}
          </dd>
        </dl>
        {app.fs?.desktop ? (
          <div className="row-actions">
            <button className="btn primary" onClick={() => app.openInWindows(path)} autoFocus>
              <ExternalLink size={16} /> Open with default app
            </button>
            <button className="btn" onClick={() => app.showInExplorer(path)}>
              <FolderSearch size={16} /> Show in File Explorer
            </button>
          </div>
        ) : (
          <>
            <p className="hint">
              <strong>Open with default app:</strong> a web page cannot launch desktop programs, so open it from File
              Explorer at the location above. You can also try letting the browser open it:
            </p>
            <button className="btn" onClick={openInTab}>
              <ExternalLink size={16} /> Open in a new browser tab
            </button>
          </>
        )}
      </div>
    </div>
  );
}
