// What the AI panel shows of an agent task, built from its events (pure, unit-tested): the plan,
// each tool step, approvals waiting for the user, the files created or changed, and the answer.

import type { AgentEvent, ApprovalRequest, FileChange, ModelChoice, StepStatus, UsageTotal } from './agentClient';

export type TimelineItem =
  | { kind: 'step'; id: string; tool: string; label: string; status: StepStatus; summary?: string; error?: string }
  | { kind: 'note'; text: string }
  /** auto mode's decision on an action that needed permission */
  | { kind: 'review'; title: string; decision: 'allow' | 'block' | 'ask'; reason: string; paths?: string[] };

export interface AgentView {
  runId: string;
  status: 'starting' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';
  model?: string;
  /** the main model set up in NoteTOO, or the second one */
  which?: ModelChoice;
  local?: boolean;
  usage?: UsageTotal;
  /** 'prompted': the model has no native tool calling */
  tools?: 'native' | 'prompted';
  note?: string;
  /** what is happening now */
  statusText: string;
  plan: { title: string; status: string }[];
  timeline: TimelineItem[];
  approvals: { id: string; request: ApprovalRequest; state: 'pending' | 'sending' | 'approved' | 'declined' }[];
  files: FileChange[];
  /** the file the agent asked to show */
  open?: string;
  /** streamed text of the current step */
  draft: string;
  final?: string;
  sources: string[];
  error?: string;
  /** reconnecting to the PC */
  offline?: boolean;
  undo?: { undone: number; failed: string[] } | 'running';
}

export const newAgentView = (): AgentView => ({ runId: '', status: 'starting', statusText: 'Starting…', plan: [], timeline: [], approvals: [], files: [], draft: '', sources: [] });

/** The view after one event. */
export function applyAgentEvent(v: AgentView, e: AgentEvent): AgentView {
  switch (e.type) {
    case 'start':
      return { ...v, status: 'running', model: e.model, which: e.which, local: e.local, tools: e.tools, note: e.note };
    case 'usage': {
      const { seq: _s, at: _a, type: _t, ...usage } = e;
      return { ...v, usage };
    }
    case 'status':
      return { ...v, statusText: e.text };
    case 'token':
      return { ...v, draft: e.text };
    case 'note':
      return { ...v, draft: '', timeline: [...v.timeline, { kind: 'note', text: e.text }] };
    case 'step': {
      const item = { kind: 'step' as const, id: e.id, tool: e.tool, label: e.label, status: e.status, summary: e.summary, error: e.error };
      const i = v.timeline.findIndex((t) => t.kind === 'step' && t.id === e.id);
      const timeline = i >= 0 ? v.timeline.map((t, j) => (j === i ? item : t)) : [...v.timeline, item];
      return { ...v, draft: '', timeline, statusText: e.status === 'running' ? `${e.label}…` : v.statusText };
    }
    case 'plan':
      return { ...v, plan: e.steps };
    case 'approval':
      return { ...v, status: 'waiting', statusText: 'Waiting for your approval…', approvals: [...v.approvals, { id: e.id, request: e.request, state: 'pending' }] };
    case 'approval_done':
      return {
        ...v,
        status: v.status === 'waiting' ? 'running' : v.status,
        approvals: v.approvals.map((a) => (a.id === e.id ? { ...a, state: e.approved ? 'approved' : 'declined' } : a)),
      };
    case 'review':
      return { ...v, timeline: [...v.timeline, { kind: 'review', title: e.title, decision: e.decision, reason: e.reason, paths: e.paths }] };
    case 'file': {
      const files = v.files.filter((f) => !(f.path === e.change.path && f.action !== 'moved' && e.change.action === 'modified'));
      // a file created then modified in the same task stays "created"
      if (e.change.action === 'modified' && v.files.some((f) => f.path === e.change.path && f.action === 'created')) return v;
      return { ...v, files: [...files, e.change] };
    }
    case 'open':
      return { ...v, open: e.path };
    case 'final':
      return { ...v, final: e.text, draft: '', sources: e.sources };
    case 'error':
      return { ...v, error: e.kind === 'stopped' ? undefined : e.message };
    case 'end':
      return { ...v, status: e.status, statusText: '', draft: e.status === 'done' ? '' : v.draft, approvals: v.approvals.map((a) => (a.state === 'pending' || a.state === 'sending' ? { ...a, state: 'declined' } : a)) };
    case 'undo':
      return { ...v, undo: { undone: e.undone, failed: e.failed } };
  }
}

/** Files to show to the user: not the folders the agent made on the way, nor deleted ones twice. */
export function visibleChanges(v: AgentView): FileChange[] {
  return v.files.filter((f) => f.action !== 'folder');
}

const compact = (n: number) => (n < 1000 ? String(n) : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : `${Math.round(n / 1000)}K`);

/**
 * The cost line of a task, e.g. "≈ 0.21 MAD · 64K tokens in, 3K out". `perUsd` converts US dollars
 * to the chosen currency.
 */
export function costLine(u: UsageTotal, currency: string, perUsd: number): string {
  const tokens = `${compact(u.input)} tokens in, ${compact(u.output)} out${u.estimated ? ' (estimated)' : ''}`;
  if (u.local && (u.costUsd === null || u.costUsd === 0)) return `Free (runs on your PC) · ${tokens}`;
  if (u.costUsd === null) return `Price unknown (set it in AI settings) · ${tokens}`;
  const amount = u.costUsd * perUsd;
  const digits = amount === 0 ? 0 : amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  return `${u.exact ? '' : '≈ '}${amount.toFixed(digits)} ${currency} · ${tokens}`;
}
