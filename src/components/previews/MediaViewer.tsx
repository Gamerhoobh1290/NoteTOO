import { useEffect, useRef, useState } from 'react';
import { Spinner, useObjectUrl } from '../common';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * Native player; the file is streamed from an object URL (browser) or straight from disk
 * (desktop app, `src`), never read into memory.
 */
export default function MediaViewer({ file, src, kind, onOpenExternally }: { file?: File; src?: string; kind: 'video' | 'audio'; onOpenExternally?: () => void }) {
  const objectUrl = useObjectUrl(src ? null : (file ?? null));
  const url = src ?? objectUrl;
  const ref = useRef<HTMLMediaElement | null>(null);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = speed;
  }, [speed, url]);
  useEffect(() => setFailed(false), [url]);

  if (!url) return <Spinner />;
  return (
    <div className="media">
      {kind === 'video' ? (
        <video ref={(el) => void (ref.current = el)} src={url} controls preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <audio ref={(el) => void (ref.current = el)} src={url} controls preload="metadata" onError={() => setFailed(true)} />
      )}
      {failed ? (
        onOpenExternally ? (
          <div className="row-actions" style={{ alignItems: 'center' }}>
            <p className="muted">NoteTOO cannot play this file (unsupported codec).</p>
            <button className="btn" onClick={onOpenExternally}>
              Open with default app
            </button>
          </div>
        ) : (
          <p className="muted">The browser cannot play this file (unsupported codec). Open it with a media player from File Explorer.</p>
        )
      ) : (
        <label className="row-actions" style={{ alignItems: 'center' }}>
          <span className="muted">Speed</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
