// The page's side of the agent (server/agent/): starts a task on the PC and follows its events.
// Nothing runs here: the PC reads the files, calls the model and executes the tools; this module
// only shows what happens. If the connection drops (laptop asleep, Wi-Fi), it reconnects and
// continues from the last event it received; the task kept running on the PC meanwhile.

import { desktop } from '../desktop/bridge';
import { serverCall } from '../desktop/serverBridge';

/** The agent needs the NoteTOO server (it runs on the PC that has the files). */
export const agentAvailable = desktop?.mode === 'server';

export interface ApprovalRequest {
  tool: string;
  title: string;
  detail: string;
  code?: string;
  paths?: string[];
  /** auto mode handed this to the user: why */
  auto?: string;
}

/** Who answers the agent's approval requests: the user, or a reviewer model (auto mode). */
export type ApprovalMode = 'ask' | 'auto';

export interface FileChange {
  action: 'created' | 'modified' | 'moved' | 'deleted' | 'folder';
  path: string;
  from?: string;
}

export type StepStatus = 'running' | 'done' | 'error' | 'declined';

export type AgentEvent = { seq: number; at: number } & (
  | { type: 'start'; model: string; provider: string; tools: 'native' | 'prompted'; local: boolean; contextTokens: number; note?: string; which: ModelChoice }
  | ({ type: 'usage' } & UsageTotal)
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'note'; text: string }
  | { type: 'step'; id: string; tool: string; label: string; status: StepStatus; summary?: string; error?: string }
  | { type: 'plan'; steps: { title: string; status: string }[] }
  | { type: 'approval'; id: string; request: ApprovalRequest }
  | { type: 'approval_done'; id: string; approved: boolean }
  | { type: 'review'; tool: string; title: string; decision: 'allow' | 'block' | 'ask'; reason: string; paths?: string[] }
  | { type: 'file'; change: FileChange }
  | { type: 'open'; path: string }
  | { type: 'final'; text: string; sources: string[] }
  | { type: 'error'; message: string; kind: string }
  | { type: 'end'; status: 'done' | 'error' | 'stopped'; changes: FileChange[] }
  | { type: 'undo'; undone: number; failed: string[] }
);

export type ModelChoice = 'main' | 'second';

/** Tokens and price of a task so far (server/agent/runner.mts). */
export interface UsageTotal {
  input: number;
  output: number;
  /** US dollars; null when the model's price is unknown */
  costUsd: number | null;
  exact: boolean;
  estimated: boolean;
  local: boolean;
}

export class AgentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function post<T>(url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new AgentRequestError("Can't reach NoteTOO on your PC. Check that the PC is on and the NoteTOO server is running.", 0);
  }
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401) throw new AgentRequestError('You were signed out of NoteTOO. Sign in again, then try again.', 401);
  if (!res.ok) throw new AgentRequestError(j.error ?? `The NoteTOO server answered with an error (${res.status}).`, res.status);
  return j;
}

export function startRun(o: {
  root: string;
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  view: { openPath?: string; subject?: string; selection?: string };
  model: ModelChoice;
  approvals: ApprovalMode;
}) {
  return post<{ id: string }>('/api/agent/runs', o).then((r) => r.id);
}

export const stopRun = (id: string) => post(`/api/agent/runs/${id}/stop`).catch(() => {});
export const approve = (id: string, approval: string, approved: boolean) => post<{ ok: boolean }>(`/api/agent/runs/${id}/approve`, { id: approval, approved });
export const undoRun = (id: string) => post<{ undone: number; failed: string[] }>(`/api/agent/runs/${id}/undo`);

/**
 * Follows a run's events until it ends. Reconnects (with growing pauses) when the connection
 * drops, asking only for the events after the last one received. Resolves when the run ended.
 */
export async function followRun(id: string, onEvent: (e: AgentEvent) => void, o: { signal?: AbortSignal; onConnection?: (online: boolean) => void } = {}): Promise<void> {
  let after = 0;
  let delay = 1000;
  for (;;) {
    if (o.signal?.aborted) return;
    try {
      const res = await fetch(`/api/agent/runs/${id}/events?after=${after}`, { cache: 'no-store', signal: o.signal });
      if (res.status === 401) throw new AgentRequestError('You were signed out of NoteTOO. Sign in again to see the task (it keeps running on your PC).', 401);
      if (res.status === 404) throw new AgentRequestError('This task is no longer on your PC (NoteTOO was restarted).', 404);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      o.onConnection?.(true);
      delay = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (!data) continue;
          const e = JSON.parse(data) as AgentEvent;
          after = Math.max(after, e.seq);
          onEvent(e);
          if (e.type === 'end') return;
        }
      }
    } catch (e) {
      if (o.signal?.aborted || (e as DOMException).name === 'AbortError') return;
      if (e instanceof AgentRequestError) throw e;
    }
    // The stream ended without the end of the run: the connection dropped. Try again.
    o.onConnection?.(false);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 10_000);
  }
}

export interface AgentSettings {
  scripts: 'ask' | 'off';
  python: string;
  maxSteps: number;
  /** auto mode's reviewer: the model doing the task, or a set one */
  reviewer: 'same' | 'main' | 'second';
}

export interface AgentStatus {
  python: string | null;
  node: string;
  index: { files: number; indexed: number; pending: number; unreadable: number; reading: { done: number; total: number } | null };
}

export const getAgentSettings = () => serverCall<AgentSettings>('agent:get-settings');
export const setAgentSettings = (s: AgentSettings) => serverCall<AgentSettings>('agent:set-settings', s);
export const getAgentStatus = (root: string) => serverCall<AgentStatus>('agent:status', root);
/** Tests a model from the PC the way the agent calls it, with the settings in the form. */
export const checkAgentModel = (settings: unknown, model: ModelChoice) =>
  serverCall<{ ok: boolean; message: string; reply?: string }>('agent:check-model', { settings, model });
