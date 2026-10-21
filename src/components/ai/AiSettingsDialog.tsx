import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, RefreshCw, ShieldAlert } from 'lucide-react';
import { checkAgentModel, getAgentSettings, getAgentStatus, setAgentSettings, type AgentSettings, type AgentStatus, type ModelChoice } from '../../ai/agentClient';
import { chat, listModels, type ModelInfo } from '../../ai/client';
import {
  PRESETS, defaultProfile, defaultSettings, getAiSettings, isRemote, presetOf, saveAiSettings, type AiSettings, type ModelProfile, type PresetId,
} from '../../ai/settings';
import { errorMessage, toast } from '../../lib/ui';
import { useAi } from '../../state/AiContext';
import { useApp } from '../../state/AppContext';
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
  const [agent, setAgent] = useState<AgentSettings | null>(null);
  const preset = presetOf(s);
  useEffect(() => {
    if (onServer) getAgentSettings().then(setAgent, () => {});
  }, []);
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
    setS({
      ...defaultSettings(id),
      apiKey: p.provider === 'openai' && s.provider === 'openai' ? s.apiKey : '',
      baseUrl: p.baseUrl,
      // the second model and the currency don't depend on the main model
      second: s.second,
      currency: s.currency,
      perUsd: s.perUsd,
    });
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
    if (agent) setAgentSettings(agent).catch((err) => toast(`The agent settings could not be saved: ${errorMessage(err)}`, 'error'));
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

      {s.provider === 'openai' && <PriceFields value={s} onChange={(p) => set(p)} openRouter={preset === 'openrouter'} />}

      {onServer && agent && <AgentSection value={agent} onChange={setAgent} hasSecond={!!s.second} />}
      {onServer && <SecondModelSection value={s} onChange={(p) => set(p)} />}
      {onServer && agent && <AgentModelCheck settings={s} />}

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

/** The agent (on the PC): what scripts may do, which Python, how many steps; and what it found. */
function AgentSection({ value, onChange, hasSecond }: { value: AgentSettings; onChange: (s: AgentSettings) => void; hasSecond: boolean }) {
  const app = useApp();
  const root = app.fs?.desktop?.rootId;
  const [status, setStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    if (!root) return;
    let alive = true;
    const load = () => getAgentStatus(root).then((st) => alive && setStatus(st), () => {});
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [root]);
  const [major, minor] = (status?.node ?? '99.0').split('.').map(Number);
  const oldNode = major < 22 || (major === 22 && minor < 13);
  return (
    <div className="agent-settings">
      <h3>Agent</h3>
      <p className="muted hint">
        The agent works on your PC with your whole school folder: it finds and reads files, creates and changes documents. Deleting files, big
        reorganizations, scripts and internet access need permission first: yours, or in <strong>Auto</strong> mode (the switch above the
        message box) a reviewer model’s. Every change can be undone.
      </p>
      <label className="field">
        <span>Python scripts written by the agent</span>
        <select value={value.scripts} onChange={(e) => onChange({ ...value, scripts: e.target.value as AgentSettings['scripts'] })}>
          <option value="ask">Allowed, each one approved first (shows the code)</option>
          <option value="off">Never run scripts</option>
        </select>
      </label>
      <label className="field">
        <span>Python program (optional)</span>
        <input value={value.python} onChange={(e) => onChange({ ...value, python: e.target.value })} placeholder="Found automatically (py -3, python3, python)" spellCheck={false} />
      </label>
      <label className="field">
        <span>Auto mode’s reviewer</span>
        <select value={value.reviewer} onChange={(e) => onChange({ ...value, reviewer: e.target.value as AgentSettings['reviewer'] })}>
          <option value="same">The model doing the task</option>
          <option value="main">Always the main model</option>
          <option value="second" disabled={!hasSecond}>
            Always the second model{hasSecond ? '' : ' (set one up below)'}
          </option>
        </select>
      </label>
      <p className="muted hint">
        In Auto mode the reviewer reads your request and the action (never your files’ contents), then allows it, blocks it, or asks you. A
        stronger model reviews more reliably: with a small local model doing the task, an online model as reviewer is a good choice. Scripts
        with internet access, whole subjects and deleting more than 10 items always ask you; after 3 blocks in a task, you decide.
      </p>
      <label className="field">
        <span>Maximum steps per task (0 = automatic: 20 for local models, 30 for online ones)</span>
        <input type="number" min={0} max={100} value={value.maxSteps} onChange={(e) => onChange({ ...value, maxSteps: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
      </label>
      {status && (
        <p className="muted hint" role="status">
          {status.python ? `Python ${status.python} found on the PC.` : 'Python was not found on the PC: scripts are unavailable (install it from python.org).'}{' '}
          Search index: {status.index.indexed} of {status.index.indexed + status.index.pending} readable files
          {status.index.reading ? ` (reading ${status.index.reading.done}/${status.index.reading.total}…)` : ''}
          {status.index.unreadable ? `, ${status.index.unreadable} unreadable (scanned or old formats)` : ''}.
          {oldNode && ` Node.js ${status.node} on the PC is too old to read PDFs: install Node.js 22 LTS or later.`}
        </p>
      )}
    </div>
  );
}

/** Tests each model from the PC exactly as the agent calls it (with the settings as typed). */
function AgentModelCheck({ settings }: { settings: AiSettings }) {
  const [result, setResult] = useState<{ which: ModelChoice; ok: boolean; text: string } | ModelChoice | null>(null);
  const check = async (which: ModelChoice) => {
    setResult(which);
    try {
      const r = await checkAgentModel(settings, which);
      setResult({ which, ok: r.ok, text: r.message });
    } catch (e) {
      setResult({ which, ok: false, text: errorMessage(e) });
    }
  };
  const running = typeof result === 'string';
  return (
    <div className="agent-check">
      <p className="muted hint">Agent mode talks to the model from the PC, not from this browser. Check that the PC reaches each model the way the agent does:</p>
      <div className="agent-check-buttons">
        <button type="button" className="btn" disabled={running} onClick={() => void check('main')}>
          {result === 'main' ? 'Checking…' : 'Check main model from the PC'}
        </button>
        {settings.second && (
          <button type="button" className="btn" disabled={running} onClick={() => void check('second')}>
            {result === 'second' ? 'Checking…' : 'Check second model from the PC'}
          </button>
        )}
      </div>
      {result && typeof result === 'object' && (
        <div className={cls('ai-test', result.ok ? 'ok' : 'bad')} role="status">
          {result.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />} {result.which === 'second' ? 'Second model: ' : 'Main model: '}
          {result.text}
        </div>
      )}
    </div>
  );
}

/** Prices for the agent's cost line (US dollars per million tokens). */
function PriceFields({ value, onChange, openRouter }: { value: Pick<ModelProfile, 'inputPerM' | 'outputPerM'>; onChange: (p: Partial<ModelProfile>) => void; openRouter: boolean }) {
  const num = (v: string) => Math.max(0, Number(v.replace(',', '.')) || 0);
  return (
    <>
      <div className="agent-prices">
        <label className="field">
          <span>Price per million input tokens (US$)</span>
          <input type="number" min={0} step={0.01} value={value.inputPerM} onChange={(e) => onChange({ inputPerM: num(e.target.value) })} />
        </label>
        <label className="field">
          <span>…output tokens (US$)</span>
          <input type="number" min={0} step={0.01} value={value.outputPerM} onChange={(e) => onChange({ outputPerM: num(e.target.value) })} />
        </label>
      </div>
      <p className="muted hint">
        {openRouter
          ? 'Optional: OpenRouter reports the exact cost of each request; leave 0.'
          : 'Optional, for the cost shown under agent tasks (e.g. GPT-6 Luna: 0.10 and 0.50). Leave 0 if unknown.'}
      </p>
    </>
  );
}

/** A second model the agent can switch to (e.g. a cloud model for big tasks), and the cost currency. */
function SecondModelSection({ value, onChange }: { value: AiSettings; onChange: (p: Partial<AiSettings>) => void }) {
  const second = value.second;
  const set = (p: Partial<ModelProfile>) => onChange({ second: { ...(second ?? defaultProfile()), ...p } });
  const preset = second ? presetOf(second) : 'openrouter';
  return (
    <div className="agent-settings">
      <h3>Second model for the agent (optional)</h3>
      <p className="muted hint">
        Switch between your main model and this one above the AI panel's message box, per request: e.g. Ollama on your PC for quick or private
        questions, and an online model for big multi-file tasks.
      </p>
      {!second ? (
        <button type="button" className="btn small" onClick={() => onChange({ second: defaultProfile('openrouter') })}>
          Add a second model
        </button>
      ) : (
        <>
          <div className="seg ai-presets" role="radiogroup" aria-label="Second model provider">
            {(Object.keys(PRESETS) as PresetId[]).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={preset === id}
                className={cls(preset === id && 'on')}
                onClick={() => preset !== id && onChange({ second: { ...defaultProfile(id), apiKey: PRESETS[id].provider === 'openai' ? second.apiKey : '' } })}
              >
                {PRESETS[id].label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Server URL</span>
            <input value={second.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…/v1" spellCheck={false} />
          </label>
          {second.provider === 'openai' && (
            <label className="field">
              <span>API key</span>
              <input type="password" value={second.apiKey} onChange={(e) => set({ apiKey: e.target.value })} autoComplete="off" spellCheck={false} />
            </label>
          )}
          <label className="field">
            <span>Model</span>
            <input
              value={second.textModel}
              onChange={(e) => set({ textModel: e.target.value })}
              placeholder={second.provider === 'ollama' ? 'e.g. qwen3.5:9b' : 'e.g. openai/gpt-6-luna'}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Context size (tokens)</span>
            <input type="number" min={2048} step={1024} value={second.contextTokens} onChange={(e) => set({ contextTokens: Math.max(2048, Number(e.target.value) || 2048) })} />
          </label>
          {second.provider === 'openai' && <PriceFields value={second} onChange={set} openRouter={preset === 'openrouter'} />}
          {isRemote(second.baseUrl) && (
            <div className="notice notice-warn ai-privacy">
              <ShieldAlert size={15} aria-hidden /> With this model, the passages the agent reads from your files are sent to this provider.
            </div>
          )}
          <button type="button" className="link-btn" onClick={() => onChange({ second: null })}>
            Remove the second model
          </button>
        </>
      )}
      <div className="agent-prices">
        <label className="field">
          <span>Show costs in (currency code)</span>
          <input value={value.currency} maxLength={3} onChange={(e) => onChange({ currency: e.target.value.toUpperCase() })} placeholder="USD" spellCheck={false} />
        </label>
        <label className="field">
          <span>1 US$ = (in that currency)</span>
          <input type="number" min={0} step={0.01} value={value.perUsd} onChange={(e) => onChange({ perUsd: Math.max(0, Number(e.target.value.replace(',', '.')) || 0) })} />
        </label>
      </div>
      <p className="muted hint">E.g. MAD and about 9.5. Update the rate now and then; costs are estimates.</p>
    </div>
  );
}
