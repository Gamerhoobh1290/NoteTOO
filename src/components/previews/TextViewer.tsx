import { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { extName } from '../../fs/paths';
import { CODE_LANGS } from '../../lib/fileKinds';
import { errorMessage } from '../../lib/ui';
import { Spinner } from '../common';
import Markdown from '../Markdown';

const MAX_TEXT = 5 * 1024 * 1024;
const MAX_HIGHLIGHT = 1024 * 1024;

/** Reads at most MAX_TEXT bytes so a huge log file cannot freeze the page. */
function useText(file: File) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    file
      .slice(0, MAX_TEXT)
      .text()
      .then((text) => !cancelled && setState({ text, truncated: file.size > MAX_TEXT }))
      .catch((e) => !cancelled && setState({ error: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [file]);
  return state;
}

function TruncatedNotice({ show }: { show: boolean }) {
  return show ? <div className="notice">Large file: showing the first 5 MB only.</div> : null;
}

export default function TextViewer({ file, kind }: { file: File; kind: 'text' | 'markdown' | 'code' }) {
  const state = useText(file);
  const [raw, setRaw] = useState(false);
  if (!state) return <Spinner />;
  if ('error' in state) return <div className="empty">Could not read this file: {state.error}</div>;

  if (kind === 'code') return <Code text={state.text} lang={CODE_LANGS[extName(file.name)]} truncated={state.truncated} />;
  if (kind === 'text') {
    return (
      <>
        <TruncatedNotice show={state.truncated} />
        <div className="doc-scroll" style={{ padding: 0 }}>
          <pre className="text-raw">{state.text}</pre>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Markdown view">
          <button role="tab" aria-selected={!raw} className={raw ? '' : 'on'} onClick={() => setRaw(false)}>
            Formatted
          </button>
          <button role="tab" aria-selected={raw} className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </div>
      <TruncatedNotice show={state.truncated} />
      <div className="doc-scroll" style={raw ? { padding: 0 } : undefined}>
        {raw ? <pre className="text-raw">{state.text}</pre> : <Markdown text={state.text} />}
      </div>
    </>
  );
}

function Code({ text, lang, truncated }: { text: string; lang?: string; truncated: boolean }) {
  const html = useMemo(() => {
    if (!lang || !hljs.getLanguage(lang) || text.length > MAX_HIGHLIGHT) return null;
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  }, [text, lang]);
  const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  return (
    <>
      <TruncatedNotice show={truncated} />
      {!html && text.length > MAX_HIGHLIGHT && <div className="notice">Large file: syntax highlighting is turned off.</div>}
      <div className="doc-scroll" style={{ padding: 0 }}>
        <div className="code">
          <pre className="gutter" aria-hidden>
            {Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join('\n')}
          </pre>
          <pre>{html !== null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{text}</code>}</pre>
        </div>
      </div>
    </>
  );
}
