import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './agentClient';
import { applyAgentEvent, costLine, newAgentView, visibleChanges } from './agentView';

let seq = 0;
const ev = (e: Record<string, unknown>) => ({ seq: ++seq, at: 0, ...e }) as AgentEvent;
const run = (...events: Record<string, unknown>[]) => events.map(ev).reduce(applyAgentEvent, newAgentView());

describe('agent view', () => {
  it('follows a task: start, steps, streamed text, files, answer', () => {
    const v = run(
      { type: 'start', model: 'qwen3.5:9b', provider: 'ollama', tools: 'native', local: true, contextTokens: 16384 },
      { type: 'step', id: 's1', tool: 'find_files', label: 'Finding files', status: 'running' },
      { type: 'step', id: 's1', tool: 'find_files', label: 'Finding files', status: 'done', summary: '2 files' },
      { type: 'token', text: 'Partial' },
      { type: 'note', text: 'Now writing the sheet.' },
      { type: 'file', change: { action: 'folder', path: 'Maths/Fiches' } },
      { type: 'file', change: { action: 'created', path: 'Maths/Fiches/a.docx' } },
      { type: 'file', change: { action: 'modified', path: 'Maths/Fiches/a.docx' } },
      { type: 'file', change: { action: 'modified', path: 'Maths/_notes.md' } },
      { type: 'file', change: { action: 'modified', path: 'Maths/_notes.md' } },
      { type: 'final', text: 'Done.', sources: ['Maths/ch1.pdf'] },
      { type: 'end', status: 'done', changes: [] },
    );
    expect(v).toMatchObject({ status: 'done', model: 'qwen3.5:9b', local: true, final: 'Done.', sources: ['Maths/ch1.pdf'], draft: '' });
    expect(v.timeline).toEqual([
      { kind: 'step', id: 's1', tool: 'find_files', label: 'Finding files', status: 'done', summary: '2 files', error: undefined },
      { kind: 'note', text: 'Now writing the sheet.' },
    ]);
    expect(visibleChanges(v)).toEqual([
      { action: 'created', path: 'Maths/Fiches/a.docx' },
      { action: 'modified', path: 'Maths/_notes.md' },
    ]);
  });

  it('approvals wait for the user, and unanswered ones count as declined when the task ends', () => {
    const request = { tool: 'delete', title: 'Delete 1 item?', detail: '…', paths: ['a.pdf'] };
    let v = run({ type: 'approval', id: 'a1', request });
    expect(v.status).toBe('waiting');
    v = applyAgentEvent(v, ev({ type: 'approval_done', id: 'a1', approved: true }));
    expect(v.approvals[0].state).toBe('approved');
    expect(v.status).toBe('running');
    v = applyAgentEvent(v, ev({ type: 'approval', id: 'a2', request }));
    v = applyAgentEvent(v, ev({ type: 'end', status: 'stopped', changes: [] }));
    expect(v.approvals.map((a) => a.state)).toEqual(['approved', 'declined']);
  });

  it("auto mode's decisions appear in the timeline, in order with the steps", () => {
    const v = run(
      { type: 'step', id: 's1', tool: 'delete', label: 'Deleting 1 item(s)', status: 'running' },
      { type: 'review', tool: 'delete', title: 'Delete 1 item?', decision: 'block', reason: 'You did not ask for it.', paths: ['a.pdf'] },
      { type: 'step', id: 's1', tool: 'delete', label: 'Deleting 1 item(s)', status: 'declined', summary: 'blocked by auto mode' },
    );
    expect(v.timeline).toEqual([
      { kind: 'step', id: 's1', tool: 'delete', label: 'Deleting 1 item(s)', status: 'declined', summary: 'blocked by auto mode', error: undefined },
      { kind: 'review', title: 'Delete 1 item?', decision: 'block', reason: 'You did not ask for it.', paths: ['a.pdf'] },
    ]);
  });

  it('errors are shown, a stop is not an error', () => {
    expect(run({ type: 'error', message: "Can't reach Ollama", kind: 'unreachable' }).error).toBe("Can't reach Ollama");
    expect(run({ type: 'error', message: 'Stopped.', kind: 'stopped' }).error).toBeUndefined();
  });

  it('formats the cost line', () => {
    const u = { input: 64_200, output: 3_100, costUsd: 0.0221, exact: false, estimated: false, local: false };
    expect(costLine(u, 'MAD', 9.5)).toBe('≈ 0.210 MAD · 64.2K tokens in, 3.1K out');
    expect(costLine({ ...u, exact: true }, 'USD', 1)).toBe('0.022 USD · 64.2K tokens in, 3.1K out');
    expect(costLine({ ...u, costUsd: 0, local: true }, 'MAD', 9.5)).toBe('Free (runs on your PC) · 64.2K tokens in, 3.1K out');
    expect(costLine({ ...u, costUsd: null, estimated: true, input: 800 }, 'MAD', 9.5)).toBe('Price unknown (set it in AI settings) · 800 tokens in, 3.1K out (estimated)');
    expect(run({ type: 'usage', ...u }).usage).toEqual(u);
  });
});
