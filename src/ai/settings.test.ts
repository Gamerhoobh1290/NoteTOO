import { describe, expect, it } from 'vitest';
import { isLocalNetwork, parseAiSettings } from './settings';

describe('AI settings', () => {
  it('reads settings saved by older versions (no prices, second model or currency)', () => {
    expect(parseAiSettings({ provider: 'ollama', baseUrl: 'http://localhost:11434', textModel: 'qwen3.5:9b', contextTokens: 16384 } as never)).toEqual({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      apiKey: '',
      textModel: 'qwen3.5:9b',
      visionModel: '',
      contextTokens: 16384,
      inputPerM: 0,
      outputPerM: 0,
      second: null,
      currency: 'USD',
      perUsd: 1,
    });
  });

  it('keeps a second model and the currency; drops invalid values', () => {
    const s = parseAiSettings({
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      textModel: 'qwen3.5:9b',
      second: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', textModel: 'openai/gpt-6-luna', contextTokens: 64000, inputPerM: 0.1, outputPerM: -3 },
      currency: ' mad ',
      perUsd: 9.5,
    } as never)!;
    expect(s.second).toEqual({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k', textModel: 'openai/gpt-6-luna', contextTokens: 64000, inputPerM: 0.1, outputPerM: 0 });
    expect([s.currency, s.perUsd]).toEqual(['MAD', 9.5]);
    expect(parseAiSettings({ currency: 'dirham', perUsd: 0, second: { baseUrl: '', textModel: '' } } as never)).toMatchObject({ currency: 'USD', perUsd: 1, second: null });
  });

  it('tells models on this PC or the home network from online ones', () => {
    for (const u of ['http://localhost:11434', 'http://192.168.1.20:1234/v1', 'http://100.101.102.103:11434', 'http://pc.tail1234.ts.net']) expect(isLocalNetwork(u)).toBe(true);
    for (const u of ['https://openrouter.ai/api/v1', 'https://api.openai.com/v1', 'not a url']) expect(isLocalNetwork(u)).toBe(false);
  });
});
