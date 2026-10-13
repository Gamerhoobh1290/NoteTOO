// AI settings for THIS browser/PC. The only thing NoteTOO keeps in browser storage, on purpose:
// each PC has its own setup (e.g. Ollama on a desktop, OpenRouter on a laptop) and an API key
// must never end up in the synced school folder. Losing it only means re-entering it.

import { useSyncExternalStore } from 'react';

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

function read(): AiSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<AiSettings>;
    const base = defaultSettings(v.provider === 'openai' ? 'custom' : 'ollama');
    return {
      provider: v.provider === 'openai' ? 'openai' : 'ollama',
      baseUrl: typeof v.baseUrl === 'string' ? v.baseUrl : base.baseUrl,
      apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
      textModel: typeof v.textModel === 'string' ? v.textModel : '',
      visionModel: typeof v.visionModel === 'string' ? v.visionModel : '',
      contextTokens: typeof v.contextTokens === 'number' && v.contextTokens >= 2048 ? v.contextTokens : base.contextTokens,
    };
  } catch {
    return null; // blocked or cleared storage just means "not set up"
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getAiSettings(): AiSettings | null {
  return current;
}

/** Saves for this browser only. Returns false when the browser refuses storage (kept for this session). */
export function saveAiSettings(s: AiSettings): boolean {
  current = { ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, ''), textModel: s.textModel.trim(), visionModel: s.visionModel.trim() };
  listeners.forEach((l) => l());
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
