// The ONLY module that talks to an AI server. Two transports behind one `chat()`:
//  - Ollama's native API (/api/chat): lets us set the context size (num_ctx) and a JSON schema.
//  - OpenAI-compatible APIs (/chat/completions): OpenRouter, LM Studio, Groq, etc.
// Both stream, and both stop on `signal`.

import type { AiSettings } from './settings';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** data: URLs (JPEG/PNG); only sent to the vision model */
  images?: string[];
}

export interface ChatOptions {
  messages: ChatMessage[];
  /** JSON schema the answer must follow (Ollama enforces it; others get JSON mode) */
  schema?: object;
  /** use the vision model (falls back to the text model when none is set) */
  vision?: boolean;
  signal?: AbortSignal;
  /** called with the visible answer so far, as it streams */
  onToken?: (textSoFar: string) => void;
}

export type AiErrorKind = 'unreachable' | 'auth' | 'model' | 'rate' | 'other';

export class AiError extends Error {
  constructor(
    message: string,
    public kind: AiErrorKind = 'other',
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export interface ModelInfo {
  id: string;
  vision: boolean;
}

/** Removes <think>…</think> reasoning that some models put in their answer (also an unfinished one). */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');
}

function modelFor(s: AiSettings, vision?: boolean): string {
  return (vision && s.visionModel) || s.textModel;
}

function unreachable(s: AiSettings): AiError {
  return s.provider === 'ollama'
    ? new AiError(`Can't reach Ollama at ${s.baseUrl}. Is it running? Start the Ollama app, then try again.`, 'unreachable')
    : new AiError(`Can't reach ${s.baseUrl}. Check your internet connection and the server URL in AI settings.`, 'unreachable');
}

async function httpError(s: AiSettings, res: Response, model: string): Promise<AiError> {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body) as { error?: string | { message?: string } };
      detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? body);
    } catch {
      detail = body;
    }
  } catch {
    /* no body */
  }
  detail = detail.trim().slice(0, 300);
  if (res.status === 401 || res.status === 403) return new AiError('The server refused the API key. Check it in AI settings.', 'auth');
  if (res.status === 429) return new AiError('Rate limit reached (common with free models). Wait a minute, or pick another model.', 'rate');
  if (res.status === 404 || /model .*not found|no such model|not a valid model/i.test(detail)) {
    return s.provider === 'ollama'
      ? new AiError(`Model "${model}" is not installed. Run \`ollama pull ${model}\` in a terminal, or pick another model in AI settings.`, 'model')
      : new AiError(`Model "${model}" was not found on this server. Pick another model in AI settings.`, 'model');
  }
  return new AiError(`The AI server answered with an error (${res.status})${detail ? `: ${detail}` : '.'}`);
}

async function post(s: AiSettings, url: string, body: unknown, signal?: AbortSignal, model = ''): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
        ...(s.provider === 'openai' ? { 'X-Title': 'NoteTOO' } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    throw unreachable(s);
  }
  if (!res.ok) throw await httpError(s, res, model);
  return res;
}

/** Reads a streamed body line by line. */
async function* lines(res: Response): AsyncGenerator<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

const base64Of = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1);

async function chatOllama(s: AiSettings, o: ChatOptions, model: string, think: boolean): Promise<string> {
  const res = await post(
    s,
    `${s.baseUrl}/api/chat`,
    {
      model,
      stream: true,
      // Reasoning makes small local models much slower without helping these tasks.
      ...(think ? {} : { think: false }),
      options: { num_ctx: s.contextTokens },
      ...(o.schema ? { format: o.schema } : {}),
      messages: o.messages.map((m) => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images.map(base64Of) } : {}) })),
    },
    o.signal,
    model,
  );
  let text = '';
  for await (const line of lines(res)) {
    let j: { message?: { content?: string }; error?: string };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.error) throw new AiError(`Ollama: ${j.error}`);
    if (j.message?.content) {
      text += j.message.content;
      o.onToken?.(stripThinking(text));
    }
  }
  return stripThinking(text);
}

async function chatOpenAi(s: AiSettings, o: ChatOptions, model: string, jsonMode: boolean): Promise<string> {
  const res = await post(
    s,
    `${s.baseUrl}/chat/completions`,
    {
      model,
      stream: true,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      messages: o.messages.map((m) =>
        m.images?.length
          ? { role: m.role, content: [{ type: 'text', text: m.content }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))] }
          : { role: m.role, content: m.content },
      ),
    },
    o.signal,
    model,
  );
  let text = '';
  for await (const line of lines(res)) {
    if (!line.startsWith('data:')) continue; // SSE comments / keep-alives
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let j: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new AiError(`The AI server reported an error: ${j.error.message ?? 'unknown'}`);
    const piece = j.choices?.[0]?.delta?.content;
    if (piece) {
      text += piece;
      o.onToken?.(stripThinking(text));
    }
  }
  return stripThinking(text);
}

/** Sends a conversation and returns the full answer (streamed through `onToken`). */
export async function chat(s: AiSettings, o: ChatOptions): Promise<string> {
  const model = modelFor(s, o.vision);
  if (s.provider === 'ollama') {
    try {
      return await chatOllama(s, o, model, false);
    } catch (e) {
      // Models without a thinking mode may reject `think`: retry without it.
      if (e instanceof AiError && /think/i.test(e.message)) return chatOllama(s, o, model, true);
      throw e;
    }
  }
  try {
    return await chatOpenAi(s, o, model, !!o.schema);
  } catch (e) {
    // Some models/providers don't support JSON mode: the prompt still asks for JSON.
    if (o.schema && e instanceof AiError && e.kind === 'other' && /response_format|json/i.test(e.message)) return chatOpenAi(s, o, model, false);
    throw e;
  }
}

/** Models the server offers (installed ones for Ollama). */
export async function listModels(s: AiSettings, signal?: AbortSignal): Promise<ModelInfo[]> {
  const url = s.provider === 'ollama' ? `${s.baseUrl}/api/tags` : `${s.baseUrl}/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}, signal });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') throw e;
    throw unreachable(s);
  }
  if (!res.ok) throw await httpError(s, res, '');
  const j = (await res.json()) as {
    models?: { name: string; capabilities?: string[] }[];
    data?: { id: string; architecture?: { input_modalities?: string[] } }[];
  };
  if (s.provider === 'ollama') {
    return (j.models ?? [])
      .filter((m) => !m.capabilities?.includes('embedding'))
      .map((m) => ({ id: m.name, vision: !!m.capabilities?.includes('vision') }));
  }
  return (j.data ?? []).map((m) => ({ id: m.id, vision: !!m.architecture?.input_modalities?.includes('image') }));
}
