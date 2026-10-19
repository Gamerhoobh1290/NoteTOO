// AI settings for THIS browser/PC. The only thing NoteTOO keeps in browser storage, on purpose:
// each PC has its own setup (e.g. Ollama on a desktop, OpenRouter on a laptop) and an API key
// must never end up in the synced school folder. Losing it only means re-entering it.
// Connected to the NoteTOO server, they are kept on the PC instead (server.json): that PC runs the
// AI, and every browser that connects uses the same setup.

import { useSyncExternalStore } from 'react';
import { desktop } from '../desktop/bridge';
import { serverCall } from '../desktop/serverBridge';

export type Provider = 'ollama' | 'openai';

export interface AiSettings {
  /** 'ollama' = Ollama's native API; 'openai' = any OpenAI-compatible server (OpenRouter, LM Studio…) */
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  textModel: string;
  /** optional; used for images and scanned PDFs */
  visionModel: string;
  /** context window in tokens; bounds how much of a file is sent at once */
  contextTokens: number;
}

export const PRESETS = {
  ollama: { label: 'Ollama (this PC)', provider: 'ollama', baseUrl: 'http://localhost:11434', contextTokens: 16384 },
  openrouter: { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', contextTokens: 32000 },
  custom: { label: 'Custom (OpenAI-compatible)', provider: 'openai', baseUrl: '', contextTokens: 16384 },
} as const satisfies Record<string, Pick<AiSettings, 'provider' | 'baseUrl' | 'contextTokens'> & { label: string }>;
export type PresetId = keyof typeof PRESETS;

export function presetOf(s: Pick<AiSettings, 'provider' | 'baseUrl'>): PresetId {
  if (s.provider === 'ollama') return 'ollama';
  return s.baseUrl.replace(/\/+$/, '') === PRESETS.openrouter.baseUrl ? 'openrouter' : 'custom';
}

export function defaultSettings(preset: PresetId = 'ollama'): AiSettings {
  const p = PRESETS[preset];
  return { provider: p.provider, baseUrl: p.baseUrl, apiKey: '', textModel: '', visionModel: '', contextTokens: p.contextTokens };
}

export function isConfigured(s: AiSettings | null): s is AiSettings {
  return !!s && !!s.baseUrl.trim() && !!s.textModel.trim();
}

/** True when requests leave this computer (file contents are then sent to a third party). */
export function isRemote(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && !host.endsWith('.localhost');
  } catch {
    return true;
  }
}

const KEY = 'notetoo.ai.v1';
const onServer = desktop?.mode === 'server';

function parse(v: Partial<AiSettings> | null): AiSettings | null {
  if (!v || typeof v !== 'object') return null;
  const base = defaultSettings(v.provider === 'openai' ? 'custom' : 'ollama');
  return {
    provider: v.provider === 'openai' ? 'openai' : 'ollama',
    baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : base.baseUrl,
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    textModel: typeof v.textModel === 'string' ? v.textModel : '',
    visionModel: typeof v.visionModel === 'string' ? v.visionModel : '',
    contextTokens: typeof v.contextTokens === 'number' && v.contextTokens >= 2048 ? v.contextTokens : base.contextTokens,
  };
}

function read(): AiSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parse(JSON.parse(raw) as Partial<AiSettings>) : null;
  } catch {
    return null; // blocked or cleared storage just means "not set up"
  }
}

let current = onServer ? null : read();
const listeners = new Set<() => void>();

if (onServer) {
  void serverCall<Partial<AiSettings> | null>('ai:get-settings')
    .then((v) => {
      current ??= parse(v);
      listeners.forEach((l) => l());
    })
    .catch(() => {}); // the connection banner says why; the panel shows "Not set up" meanwhile
}

export function getAiSettings(): AiSettings | null {
  return current;
}

/**
 * Saves for this browser only (or on the PC, connected to the NoteTOO server). Resolves false when
 * they could not be stored; they are still used until NoteTOO is closed.
 */
export async function saveAiSettings(s: AiSettings): Promise<boolean> {
  current = { ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, ''), textModel: s.textModel.trim(), visionModel: s.visionModel.trim() };
  listeners.forEach((l) => l());
  if (onServer) return serverCall('ai:set-settings', current).then(() => true, () => false);
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    return true;
  } catch {
    return false;
  }
}

export function useAiSettings(): AiSettings | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
