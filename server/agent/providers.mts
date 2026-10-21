// The agent's model client, on the PC: one conversation format and one tool-call format for every
// provider NoteTOO supports, so the same tools and the same loop run on a local model and an API.
//  - Ollama's native API (/api/chat): `tools`, streamed `message.tool_calls`, num_ctx.
//  - OpenAI-compatible APIs (/chat/completions: OpenRouter, LM Studio, Groq, vLLM, Ollama's /v1…):
//    `tools`, streamed `delta.tool_calls` fragments.
//  - "Prompted" mode for models without native tool calling: the tools are described in the
//    system prompt and the model answers with one JSON object per step (Ollama enforces the schema).
// Small local models sometimes write a tool call as text (<tool_call>{…}</tool_call>) instead of
// using the API: those are recognized too.

import * as http from 'node:http';
import * as https from 'node:https';
import { isLinkLocal, noLinkLocal } from '../net.mjs';

export type Provider = 'ollama' | 'openai';

/** The AI settings set up in NoteTOO (src/ai/settings.ts), as stored in server.json. */
export interface ModelSettings {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  textModel: string;
  contextTokens: number;
  /** US dollars per million input / output tokens set by the user (0 = unknown) */
  inputPerM?: number;
  outputPerM?: number;
}

/** Tokens a model turn used, as the provider reported them; `costUsd` when the provider bills it exactly. */
export interface Usage {
  input: number;
  output: number;
  costUsd?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the arguments (type: object) */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** the arguments were not valid JSON: told to the model instead of running the tool */
  argsError?: string;
}

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type ToolMode = 'native' | 'prompted';

export interface Capabilities {
  tools: ToolMode;
  /** context window used for budgeting (the smaller of the setting and the model's own limit) */
  contextTokens: number;
  /** the model runs on this PC or the local network */
  local: boolean;
  /** why tools are prompted, for display */
  note?: string;
  /** prices the provider lists for the model, in US dollars per million tokens */
  pricing?: { inputPerM: number; outputPerM: number };
}

export interface StepResult {
  content: string;
  toolCalls: ToolCall[];
  /** the step ended because the answer hit the output limit */
  truncated?: boolean;
  usage?: Usage;
}

export type ModelErrorKind = 'unreachable' | 'auth' | 'model' | 'rate' | 'context' | 'tools' | 'server' | 'other';

export class ModelError extends Error {
  constructor(
    message: string,
    readonly kind: ModelErrorKind = 'other',
  ) {
    super(message);
    this.name = 'ModelError';
  }
  /** Worth one more try after a pause. */
  get retryable() {
    return this.kind === 'rate' || this.kind === 'server' || this.kind === 'unreachable';
  }
}

// ---------- HTTP ----------

interface Res {
  status: number;
  lines: AsyncGenerator<string>;
  text: () => Promise<string>;
}

/** A model server takes this long, at most, between two pieces of an answer (loading a model included). */
const IDLE_MS = 5 * 60_000;

export function checkBaseUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ModelError('The AI server address is invalid. Check it in AI settings.', 'other');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash || isLinkLocal(u.hostname)) {
    throw new ModelError('The AI server address is invalid. Check it in AI settings.', 'other');
  }
  return u;
}

function request(s: ModelSettings, sub: string, o: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<Res> {
  const base = checkBaseUrl(s.baseUrl);
  const target = new URL(base.pathname.replace(/\/+$/, '') + sub, base.origin);
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
  const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
  if (payload) Object.assign(headers, { 'content-type': 'application/json', 'content-length': String(payload.length) });
  if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
  if (s.provider === 'openai') headers['x-title'] = 'NoteTOO';
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(o.signal.reason);
    const req = (target.protocol === 'https:' ? https : http).request(target, { method: o.method ?? (payload ? 'POST' : 'GET'), headers, lookup: noLinkLocal }, (res) => {
      res.setTimeout(IDLE_MS, () => res.destroy(new ModelError('The AI server stopped answering (no response for 5 minutes).', 'server')));
      async function* lines() {
        let buf = '';
        for await (const chunk of res as AsyncIterable<Buffer>) {
          buf += chunk.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) yield line;
          }
        }
        if (buf.trim()) yield buf.trim();
      }
      resolve({
        status: res.statusCode ?? 0,
        lines: lines(),
        text: async () => {
          let t = '';
          for await (const chunk of res as AsyncIterable<Buffer>) t += chunk.toString('utf8');
          return t;
        },
      });
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new ModelError('The AI server did not answer in time.', 'unreachable')));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (o.signal?.aborted) return reject(o.signal.reason);
      if (e instanceof ModelError) return reject(e);
      reject(unreachable(s, e.code));
    });
    o.signal?.addEventListener('abort', () => req.destroy(), { once: true });
    req.end(payload);
  });
}

function unreachable(s: ModelSettings, code?: string): ModelError {
  return s.provider === 'ollama'
    ? new ModelError(`Can't reach Ollama at ${s.baseUrl} on this PC${code ? ` (${code})` : ''}. Is it running? Start the Ollama app, then try again.`, 'unreachable')
    : new ModelError(`Can't reach ${s.baseUrl}${code ? ` (${code})` : ''}. Check the PC's internet connection and the server URL in AI settings.`, 'unreachable');
}

/** Maps an HTTP error answer to a clear message (shown to the user as is). */
export function httpError(s: ModelSettings, status: number, body: string): ModelError {
  let detail = body;
  try {
    const j = JSON.parse(body) as { error?: string | { message?: string; metadata?: { raw?: string } } };
    detail = typeof j.error === 'string' ? j.error : (j.error?.message ?? body);
  } catch {
    /* not JSON */
  }
  detail = detail.trim().slice(0, 400);
  const model = s.textModel;
  if (/does not support tools|tool(s| use| calling)? (is |are )?not supported|support tool use|no endpoints found that support tool|tools? .*unsupported|unsupported .*tools?|"?tool_choice"? is not supported/i.test(detail)) {
    return new ModelError(`"${model}" does not support tool calling: ${detail}`, 'tools');
  }
  if (/context (length|window)|maximum context|too many tokens|context_length_exceeded|prompt is too long|reduce the length/i.test(detail)) {
    return new ModelError(`The conversation is too long for the model's context window: ${detail}`, 'context');
  }
  if (status === 401 || status === 403) return new ModelError('The AI server refused the API key. Check it in AI settings.', 'auth');
  if (status === 402) return new ModelError(`The provider refused the request: no credit left on the API key${detail ? ` (${detail})` : ''}.`, 'auth');
  if (status === 429) return new ModelError('Rate limit reached (common with free models). Wait a minute, or pick another model.', 'rate');
  if (status === 404 || /model .*not found|no such model|not a valid model|model .* does not exist/i.test(detail)) {
    return s.provider === 'ollama'
      ? new ModelError(`Model "${model}" is not installed. Run \`ollama pull ${model}\` on the PC, or pick another model in AI settings.`, 'model')
      : new ModelError(`Model "${model}" was not found on this server. Pick another model in AI settings.`, 'model');
  }
  if (status >= 500) return new ModelError(`The AI server had an internal error (${status})${detail ? `: ${detail}` : '.'}`, 'server');
  return new ModelError(`The AI server answered with an error (${status})${detail ? `: ${detail}` : '.'}`);
}

// ---------- tool-call arguments ----------

/** Parses tool arguments: an object (Ollama) or a JSON string (OpenAI), tolerating fences and trailing commas. */
export function parseArgs(raw: unknown): { args: Record<string, unknown>; error?: string } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { args: raw as Record<string, unknown> };
  if (raw === undefined || raw === null || raw === '') return { args: {} };
  if (typeof raw !== 'string') return { args: {}, error: 'The arguments must be a JSON object.' };
  let t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = JSON.parse(t) as unknown;
      // Some models double-encode: "{\"path\": …}"
      if (typeof v === 'string') return parseArgs(v);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
      return { args: {}, error: 'The arguments must be a JSON object.' };
    } catch (e) {
      if (attempt) return { args: {}, error: `The arguments are not valid JSON (${(e as Error).message}).` };
      t = t.replace(/,\s*([}\]])/g, '$1');
    }
  }
  return { args: {} };
}

let callSeq = 0;
const newCallId = () => `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`;

/** The first balanced JSON object starting at `from`, or null. */
function balancedObject(text: string, from: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * Tool calls a model wrote as text instead of through the API: Qwen/Hermes `<tool_call>` tags, a
 * fenced or bare `{"name": …, "arguments": …}` object. Only names of known tools count.
 */
export function textToolCalls(content: string, toolNames: Set<string>): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  let rest = content;
  const take = (json: string, whole: string) => {
    let v: { name?: unknown; arguments?: unknown; parameters?: unknown; function?: { name?: unknown; arguments?: unknown } };
    try {
      v = JSON.parse(json);
    } catch {
      return;
    }
    const name = typeof v.name === 'string' ? v.name : typeof v.function?.name === 'string' ? v.function.name : '';
    if (!toolNames.has(name)) return;
    const { args, error } = parseArgs(v.arguments ?? v.parameters ?? v.function?.arguments);
    calls.push({ id: newCallId(), name, args, ...(error ? { argsError: error } : {}) });
    rest = rest.replace(whole, '');
  };
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*(<\/tool_call>|$)/g)) {
    const start = m[1].indexOf('{');
    const obj = start >= 0 ? balancedObject(m[1], start) : null;
    if (obj) take(obj, m[0]);
  }
  if (!calls.length) {
    const t = content.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
    const body = fenced ? fenced[1] : t;
    if (body.startsWith('{')) {
      const obj = balancedObject(body, 0);
      if (obj && obj.length >= body.length - 2) take(obj, content);
    }
  }
  return { calls, rest: rest.trim() };
}

// ---------- capabilities ----------

const capsCache = new Map<string, { at: number; caps: Capabilities }>();

function isLocalUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return /^(localhost|127\.|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h) || h.endsWith('.local') || h.endsWith('.ts.net');
  } catch {
    return false;
  }
}

/** What the model can do: native tool calling, and its context window. Cached for 10 minutes. */
export async function detectCapabilities(s: ModelSettings, signal?: AbortSignal): Promise<Capabilities> {
  const key = `${s.provider}|${s.baseUrl}|${s.textModel}|${s.contextTokens}`;
  const hit = capsCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.caps;
  const caps: Capabilities = { tools: 'native', contextTokens: s.contextTokens, local: s.provider === 'ollama' || isLocalUrl(s.baseUrl) };
  try {
    if (s.provider === 'ollama') {
      const res = await request(s, '/api/show', { body: { model: s.textModel }, signal });
      const body = await res.text();
      if (res.status === 404) throw httpError(s, 404, body);
      if (res.status === 200) {
        const j = JSON.parse(body) as { capabilities?: string[]; model_info?: Record<string, unknown> };
        if (Array.isArray(j.capabilities) && !j.capabilities.includes('tools')) {
          caps.tools = 'prompted';
          caps.note = `${s.textModel} has no native tool calling in Ollama; NoteTOO describes the tools in the prompt instead.`;
        }
        const ctx = Object.entries(j.model_info ?? {}).find(([k]) => k.endsWith('.context_length'))?.[1];
        if (typeof ctx === 'number' && ctx > 2048) caps.contextTokens = Math.min(caps.contextTokens, ctx);
      }
    } else {
      const res = await request(s, '/models', { signal });
      if (res.status === 200) {
        const j = JSON.parse(await res.text()) as {
          data?: { id: string; context_length?: number; supported_parameters?: string[]; pricing?: { prompt?: string | number; completion?: string | number } }[];
        };
        const m = j.data?.find((x) => x.id === s.textModel);
        if (m?.supported_parameters && !m.supported_parameters.includes('tools')) {
          caps.tools = 'prompted';
          caps.note = `${s.textModel} has no native tool calling on this provider; NoteTOO describes the tools in the prompt instead.`;
        }
        if (m?.context_length && m.context_length > 2048) caps.contextTokens = Math.min(caps.contextTokens, m.context_length);
        // OpenRouter lists prices per token, in US dollars.
        const perM = (x: unknown) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Number(x) * 1e6 : NaN);
        const [pin, pout] = [perM(m?.pricing?.prompt), perM(m?.pricing?.completion)];
        if (!Number.isNaN(pin) && !Number.isNaN(pout)) caps.pricing = { inputPerM: pin, outputPerM: pout };
      } else await res.text();
    }
  } catch (e) {
    if (signal?.aborted || (e instanceof ModelError && (e.kind === 'model' || e.kind === 'unreachable'))) throw e;
    // Unknown: try native tools; a refusal switches to prompted mode then.
  }
  capsCache.set(key, { at: Date.now(), caps });
  return caps;
}

/** Remembers that a model refused native tools (until NoteTOO restarts). */
export function markPrompted(s: ModelSettings, note: string) {
  const key = `${s.provider}|${s.baseUrl}|${s.textModel}|${s.contextTokens}`;
  const caps = capsCache.get(key)?.caps ?? { tools: 'prompted', contextTokens: s.contextTokens, local: s.provider === 'ollama' || isLocalUrl(s.baseUrl) };
  capsCache.set(key, { at: Date.now(), caps: { ...caps, tools: 'prompted', note } });
}

// ---------- prompted mode ----------

/** Instructions for models without native tool calling (appended to the system prompt). */
export function promptedInstructions(tools: ToolSpec[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  arguments (JSON schema): ${JSON.stringify(t.parameters)}`).join('\n');
  return [
    'TOOLS. You act by calling tools. Reply with ONE JSON object and nothing else, in one of these two forms:',
    '{"action": "<tool name>", "args": { ...arguments... }}   to call a tool; you will get its result in the next message.',
    '{"action": "final", "answer": "<your complete answer to the user, in Markdown>"}   when the task is done.',
    'Call one tool per reply. Never invent a tool result.',
    'Available tools:',
    list,
  ].join('\n');
}

function promptedSchema(tools: ToolSpec[]) {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...tools.map((t) => t.name), 'final'] },
      args: { type: 'object' },
      answer: { type: 'string' },
    },
    required: ['action'],
  };
}

/** Reads a prompted-mode reply. A reply that is not JSON is taken as the final answer. */
export function parsePromptedReply(text: string, tools: Set<string>): StepResult {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = t.indexOf('{');
  const obj = start >= 0 ? balancedObject(t, start) : null;
  if (obj) {
    try {
      const v = JSON.parse(obj) as { action?: unknown; args?: unknown; answer?: unknown; name?: unknown; arguments?: unknown };
      const action = typeof v.action === 'string' ? v.action : typeof v.name === 'string' ? v.name : '';
      if (action === 'final' || (!action && typeof v.answer === 'string')) return { content: String(v.answer ?? ''), toolCalls: [] };
      if (tools.has(action)) {
        const { args, error } = parseArgs(v.args ?? v.arguments);
        return { content: '', toolCalls: [{ id: newCallId(), name: action, args, ...(error ? { argsError: error } : {}) }] };
      }
      if (action) return { content: '', toolCalls: [{ id: newCallId(), name: action, args: {}, argsError: `There is no tool named "${action}".` }] };
    } catch {
      /* not JSON after all */
    }
  }
  return { content: text.trim(), toolCalls: [] };
}

/** Prompted mode: tool calls and results become ordinary text turns. */
function promptedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const c = m.toolCalls[0];
      return { role: 'assistant', content: JSON.stringify({ action: c.name, args: c.args }) };
    }
    if (m.role === 'tool') return { role: 'user', content: `Result of ${m.name}:\n${m.content}` };
    return m;
  });
}

// ---------- one step ----------

export interface StepOptions {
  messages: AgentMessage[];
  tools: ToolSpec[];
  mode: ToolMode;
  signal?: AbortSignal;
  /** visible answer text so far (native mode) */
  onToken?: (text: string) => void;
}

const stripThinking = (t: string) => t.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '');

/** Ollama models that refused `think: false`. */
const noThinkParam = new Set<string>();

async function stepOllama(s: ModelSettings, o: StepOptions): Promise<StepResult> {
  const prompted = o.mode === 'prompted';
  const msgs = prompted ? promptedMessages(o.messages) : o.messages;
  const body = {
    model: s.textModel,
    stream: true,
    // Reasoning makes local models much slower; tool use works without it.
    ...(noThinkParam.has(s.textModel) ? {} : { think: false }),
    options: { num_ctx: s.contextTokens },
    ...(prompted ? { format: promptedSchema(o.tools) } : o.tools.length ? { tools: o.tools.map((t) => ({ type: 'function', function: t })) } : {}),
    messages: msgs.map((m) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) } : {}),
        };
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
      return { role: m.role, content: m.content };
    }),
  };
  const res = await request(s, '/api/chat', { body, signal: o.signal });
  if (res.status !== 200) {
    const err = httpError(s, res.status, await res.text());
    if (/think/i.test(err.message) && !noThinkParam.has(s.textModel)) {
      noThinkParam.add(s.textModel);
      return stepOllama(s, o);
    }
    throw err;
  }
  let text = '';
  const calls: ToolCall[] = [];
  let truncated = false;
  let usage: Usage | undefined;
  for await (const line of res.lines) {
    let j: {
      message?: { content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
      error?: string;
      done?: boolean;
      done_reason?: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.error) throw httpError(s, 500, JSON.stringify({ error: j.error }));
    if (j.message?.content) {
      text += j.message.content;
      if (!prompted) o.onToken?.(stripThinking(text));
    }
    for (const c of j.message?.tool_calls ?? []) {
      if (!c.function?.name) continue;
      const { args, error } = parseArgs(c.function.arguments);
      calls.push({ id: newCallId(), name: c.function.name, args, ...(error ? { argsError: error } : {}) });
    }
    if (j.done && j.done_reason === 'length') truncated = true;
    if (j.done && (j.prompt_eval_count || j.eval_count)) usage = { input: j.prompt_eval_count ?? 0, output: j.eval_count ?? 0 };
  }
  return finish(prompted, stripThinking(text), calls, o.tools, truncated, usage);
}

/** Servers that refused `stream_options` (asking for token usage in the stream). */
const noUsageOption = new Set<string>();

async function stepOpenAi(s: ModelSettings, o: StepOptions, jsonMode = true): Promise<StepResult> {
  const prompted = o.mode === 'prompted';
  const msgs = prompted ? promptedMessages(o.messages) : o.messages;
  const body = {
    model: s.textModel,
    stream: true,
    // The last chunk then reports the tokens used (and OpenRouter the exact cost).
    ...(noUsageOption.has(s.baseUrl) ? {} : { stream_options: { include_usage: true } }),
    ...(prompted
      ? jsonMode
        ? { response_format: { type: 'json_object' } }
        : {}
      : o.tools.length
        ? { tools: o.tools.map((t) => ({ type: 'function', function: t })), tool_choice: 'auto' }
        : {}),
    messages: msgs.map((m) => {
      if (m.role === 'assistant') {
        return m.toolCalls?.length
          ? {
              role: 'assistant',
              content: m.content || null,
              tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })),
            }
          : { role: 'assistant', content: m.content };
      }
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    }),
  };
  const res = await request(s, '/chat/completions', { body, signal: o.signal });
  if (res.status !== 200) {
    const err = httpError(s, res.status, await res.text());
    if (!noUsageOption.has(s.baseUrl) && /stream_options|include_usage/i.test(err.message)) {
      noUsageOption.add(s.baseUrl);
      return stepOpenAi(s, o, jsonMode);
    }
    // Some providers have no JSON mode: the prompt still asks for JSON.
    if (prompted && jsonMode && err.kind === 'other' && /response_format|json/i.test(err.message)) return stepOpenAi(s, o, false);
    throw err;
  }
  let text = '';
  let truncated = false;
  let usage: Usage | undefined;
  const readUsage = (u?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }) => {
    if (u && (u.prompt_tokens || u.completion_tokens)) {
      usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, ...(typeof u.cost === 'number' ? { costUsd: u.cost } : {}) };
    }
  };
  const parts = new Map<number, { id?: string; name: string; args: string }>();
  for await (const line of res.lines) {
    if (!line.startsWith('data:')) {
      // A provider answering without streaming (or an error object).
      if (line.startsWith('{')) {
        try {
          const j = JSON.parse(line) as {
            error?: { message?: string };
            choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
          };
          if (j.error) throw httpError(s, 500, JSON.stringify(j));
          readUsage(j.usage);
          const msg = j.choices?.[0]?.message;
          if (msg?.content) text += msg.content;
          msg?.tool_calls?.forEach((c, i) => parts.set(i, { id: c.id, name: c.function?.name ?? '', args: c.function?.arguments ?? '' }));
        } catch (e) {
          if (e instanceof ModelError) throw e;
        }
      }
      continue;
    }
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let j: {
      choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw httpError(s, 500, JSON.stringify({ error: j.error }));
    readUsage(j.usage);
    const ch = j.choices?.[0];
    if (ch?.delta?.content) {
      text += ch.delta.content;
      if (!prompted) o.onToken?.(stripThinking(text));
    }
    for (const tc of ch?.delta?.tool_calls ?? []) {
      const i = tc.index ?? parts.size;
      const p = parts.get(i) ?? { name: '', args: '' };
      if (tc.id) p.id = tc.id;
      if (tc.function?.name) p.name += tc.function.name;
      if (tc.function?.arguments) p.args += tc.function.arguments;
      parts.set(i, p);
    }
    if (ch?.finish_reason === 'length') truncated = true;
  }
  const calls: ToolCall[] = [...parts.values()]
    .filter((p) => p.name)
    .map((p) => {
      const { args, error } = parseArgs(p.args);
      return { id: p.id || newCallId(), name: p.name, args, ...(error ? { argsError: error } : {}) };
    });
  return finish(prompted, stripThinking(text), calls, o.tools, truncated, usage);
}

function finish(prompted: boolean, text: string, calls: ToolCall[], tools: ToolSpec[], truncated: boolean, usage?: Usage): StepResult {
  const names = new Set(tools.map((t) => t.name));
  const extra = { truncated, ...(usage ? { usage } : {}) };
  if (prompted) return { ...parsePromptedReply(text, names), ...extra };
  if (calls.length) return { content: text.trim(), toolCalls: calls, ...extra };
  const recovered = textToolCalls(text, names);
  if (recovered.calls.length) return { content: recovered.rest, toolCalls: recovered.calls, ...extra };
  return { content: text.trim(), toolCalls: [], ...extra };
}

/** One model turn: streamed text and/or tool calls, in NoteTOO's own format. */
export function chatStep(s: ModelSettings, o: StepOptions): Promise<StepResult> {
  if (!s.textModel) return Promise.reject(new ModelError('No model is set up. Pick one in AI settings.', 'model'));
  return s.provider === 'ollama' ? stepOllama(s, o) : stepOpenAi(s, o);
}

export type ModelChoice = 'main' | 'second';

/** Reads AI settings as stored by the page (server.json "ai"): the main model or the second one. */
export function modelSettings(raw: Record<string, unknown> | null, which: ModelChoice = 'main'): ModelSettings | null {
  const src = which === 'second' ? (raw?.second as Record<string, unknown> | null | undefined) : raw;
  if (!src || typeof src !== 'object') return null;
  const price = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  const s: ModelSettings = {
    provider: src.provider === 'openai' ? 'openai' : 'ollama',
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim().replace(/\/+$/, '') : '',
    apiKey: typeof src.apiKey === 'string' ? src.apiKey : '',
    textModel: typeof src.textModel === 'string' ? src.textModel.trim() : '',
    contextTokens: typeof src.contextTokens === 'number' && src.contextTokens >= 2048 ? src.contextTokens : 16384,
    inputPerM: price(src.inputPerM),
    outputPerM: price(src.outputPerM),
  };
  return s.baseUrl && s.textModel ? s : null;
}
