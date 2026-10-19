import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, ShieldAlert } from 'lucide-react';
import { chat, listModels, type ModelInfo } from '../../ai/client';
import { PRESETS, defaultSettings, getAiSettings, isRemote, presetOf, saveAiSettings, type AiSettings, type PresetId } from '../../ai/settings';
import { errorMessage, toast } from '../../lib/ui';
import { useAi } from '../../state/AiContext';
import { cls } from '../common';
import { desktop } from '../../desktop/bridge';

/** Connected to the NoteTOO server: the settings and the AI are on the PC. */
const onServer = desktop?.mode === 'server';

export function AiSettingsDialog() {
  const ai = useAi();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (ai.settingsOpen && !el.open) el.showModal();
    if (!ai.settingsOpen && el.open) el.close();
  }, [ai.settingsOpen]);

  return (
    <dialog
      ref={ref}
      className="dialog ai-settings"
      onCancel={(e) => {
        e.preventDefault();
        ai.setSettingsOpen(false);
      }}
    >
      {ai.settingsOpen && <SettingsForm close={() => ai.setSettingsOpen(false)} />}
    </dialog>
  );
}

function SettingsForm({ close }: { close: () => void }) {
  const [s, setS] = useState<AiSettings>(() => getAiSettings() ?? defaultSettings('ollama'));
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | 'running' | null>(null);
  const [reload, setReload] = useState(0);
  const preset = presetOf(s);
  const set = (p: Partial<AiSettings>) => {
    setS((x) => ({ ...x, ...p }));
    setTest(null);
  };

  // Fetch the model list whenever the server or key changes (debounced while typing).
  useEffect(() => {
    if (!s.baseUrl.trim()) return setModels(null);
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setLoadingModels(true);
      try {
        const list = await listModels({ ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, '') }, ac.signal);
        setModels(list.sort((a, b) => a.id.localeCompare(b.id)));
        setModelsError(null);
      } catch (e) {
        if ((e as DOMException).name === 'AbortError') return;
        setModels(null);
        setModelsError(errorMessage(e));
      } finally {
        if (!ac.signal.aborted) setLoadingModels(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [s.provider, s.baseUrl, s.apiKey, reload]);

  // On a fresh Ollama setup, preselect the first installed model.
  useEffect(() => {
    if (models?.length && !s.textModel && s.provider === 'ollama') {
      const m = models.find((x) => x.vision) ?? models[0];
      setS((x) => ({ ...x, textModel: m.id, visionModel: x.visionModel || (m.vision ? m.id : '') }));
    }
  }, [models]);

  const pickPreset = (id: PresetId) => {
    if (id === preset) return;
    const p = PRESETS[id];
    setS({ ...defaultSettings(id), apiKey: p.provider === 'openai' && s.provider === 'openai' ? s.apiKey : '', baseUrl: p.baseUrl });
    setModels(null);
    setTest(null);
  };

  const isVision = (id: string) => !!models?.find((m) => m.id === id)?.vision;
  const ready = !!s.baseUrl.trim() && !!s.textModel.trim();

  const runTest = async () => {
    setTest('running');
    try {
      const out = await chat(
        { ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, '') },
        { messages: [{ role: 'user', content: 'Reply with just the word OK.' }], signal: AbortSignal.timeout(120_000) },
      );
      setTest({ ok: true, text: `Connected. The model answered: “${out.trim().slice(0, 60)}”` });
    } catch (e) {
      setTest({ ok: false, text: (e as DOMException).name === 'TimeoutError' ? 'No answer within 2 minutes.' : errorMessage(e) });
    }
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    void saveAiSettings(s).then((ok) => {
      if (!ok) {
        toast(
          onServer
            ? 'The settings could not be saved on your PC: they will be forgotten when you reload NoteTOO.'
            : 'This browser refused to store the settings: they will be forgotten when you close NoteTOO.',
          'error',
        );
      }
    });
    close();
  };

  return (
    <form className="dialog-body" onSubmit={save}>
      <h2>AI settings</h2>
      <p className="muted hint">
        {onServer
          ? 'Kept on your PC, which runs the AI; every browser connected to it uses this setup. Never written to your school folder.'
          : 'Kept in this browser only (each PC has its own setup). Never written to your school folder.'}
      </p>

      <div className="seg ai-presets" role="radiogroup" aria-label="AI provider">
        {(Object.keys(PRESETS) as PresetId[]).map((id) => (
          <button key={id} type="button" role="radio" aria-checked={preset === id} className={cls(preset === id && 'on')} onClick={() => pickPreset(id)}>
            {PRESETS[id].label}
          </button>
        ))}
      </div>

      {preset === 'ollama' && (
        <p className="muted hint">
          Free and private: everything stays on {onServer ? 'your PC (the one running NoteTOO)' : 'this PC'}. Install Ollama from ollama.com, then download a model, e.g.{' '}
          <code>ollama pull qwen3.5:9b</code> (reads text and images).
        </p>
      )}
      {preset === 'openrouter' && (
        <p className="muted hint">
          Create a key at openrouter.ai (set a credit limit on it). Models ending in <code>:free</code> cost nothing but are rate-limited.
        </p>
      )}

      <label className="field">
        <span>Server URL</span>
        <input value={s.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…/v1" spellCheck={false} />
      </label>

      {s.provider === 'openai' && (
        <label className="field">
          <span>API key</span>
          <input type="password" value={s.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="off" spellCheck={false} />
        </label>
      )}

      {isRemote(s.baseUrl) && (
        <div className="notice notice-warn ai-privacy">
          <ShieldAlert size={15} aria-hidden /> With this server, the content of the files you use the AI on is sent over the internet to it. Free
          models may log what you send.
        </div>
      )}

      <datalist id="ai-models">
        {models?.map((m) => <option key={m.id} value={m.id} label={m.vision ? 'reads images' : undefined} />)}
      </datalist>
      <label className="field">
        <span>Text model</span>
        <input
          list="ai-models"
          value={s.textModel}
          onChange={(e) => {
            const id = e.target.value;
            set({ textModel: id, ...(!s.visionModel && isVision(id) ? { visionModel: id } : {}) });
          }}
          placeholder={s.provider === 'ollama' ? 'e.g. qwen3.5:9b' : 'e.g. google/gemma-3-27b-it:free'}
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>Vision model (optional, for images and scanned PDFs)</span>
        <input list="ai-models" value={s.visionModel} onChange={(e) => set({ visionModel: e.target.value })} placeholder="Same as text model if it reads images" spellCheck={false} />
      </label>
      <div className="ai-models-state muted hint">
        {loadingModels ? (
          'Loading models…'
        ) : modelsError ? (
          <span className="field-error">{modelsError}</span>
        ) : models ? (
          `${models.length} model${models.length === 1 ? '' : 's'} available${models.some((m) => m.vision) ? ` · ${models.filter((m) => m.vision).length} read images` : ''}.`
        ) : null}
        <button type="button" className="link-btn" onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={12} /> Reload list
        </button>
      </div>

      <label className="field">
        <span>Context size (tokens)</span>
        <input
          type="number"
          min={2048}
          step={1024}
          value={s.contextTokens}
          onChange={(e) => set({ contextTokens: Math.max(2048, Number(e.target.value) || 2048) })}
        />
      </label>
      <p className="muted hint">
        How much text the model reads at once. Longer files are read in parts.{' '}
        {s.provider === 'ollama' ? '16384 suits a 12 GB GPU; lower it on smaller PCs.' : 'Use the model’s context length or less.'}
      </p>

      {test && (
        <div className={cls('ai-test', test !== 'running' && (test.ok ? 'ok' : 'bad'))} role="status">
          {test === 'running' ? (
            'Testing… (the first answer can take a while while the model loads)'
          ) : (
            <>
              {test.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />} {test.text}
            </>
          )}
        </div>
      )}

      <div className="dialog-actions">
        <button type="button" className="btn" onClick={runTest} disabled={!ready || test === 'running'}>
          Test connection
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={!ready}>
          Save
        </button>
      </div>
    </form>
  );
}
