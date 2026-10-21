// The agent as the NoteTOO server offers it: starts runs on the PC, keeps them (and their events)
// for browsers to follow, one search index per shared folder, and the agent settings.

import * as path from 'node:path';
import type { ConfigStore } from '../config.mjs';
import { IndexRegistry, type WorkspaceIndex } from './index.mjs';
import { chatStep, detectCapabilities, ModelError, modelSettings, type ModelChoice } from './providers.mjs';
import { findPython } from './python.mjs';
import { AgentRun, runAgent, type RunRequest } from './runner.mjs';
import { parseAgentSettings, type AgentSettings } from './tools.mjs';

const KEEP_RUNS = 30;
const KEEP_MS = 12 * 60 * 60_000;

export class AgentUnavailable extends Error {}

export function createAgentService(store: ConfigStore) {
  const runs = new Map<string, AgentRun>();
  const indexes = new IndexRegistry(store.dataDir);

  function prune() {
    const done = [...runs.values()].filter((r) => r.finishedAt);
    for (const r of done) if (Date.now() - r.finishedAt > KEEP_MS) runs.delete(r.id);
    const extra = runs.size - KEEP_RUNS;
    if (extra > 0) for (const r of done.sort((a, b) => a.finishedAt - b.finishedAt).slice(0, extra)) runs.delete(r.id);
  }

  return {
    index(rootId: string, rootPath: string): WorkspaceIndex {
      return indexes.get(rootId, rootPath);
    },

    settings(): AgentSettings {
      return parseAgentSettings(store.get().agent);
    },

    setSettings(raw: unknown) {
      const s = parseAgentSettings(raw);
      store.update((c) => void (c.agent = { ...s }));
      return s;
    },

    /** What the agent can use on this PC (shown in the AI settings). */
    async status(rootId: string, rootPath: string) {
      const ix = indexes.get(rootId, rootPath);
      await ix.scan();
      // Reading the files for search starts as soon as someone opens the assistant.
      void ix.update({ budgetMs: 0 }).catch(() => {});
      const py = findPython(this.settings().python || undefined);
      return { python: py?.version ?? null, index: { ...ix.status(), reading: ix.progress.done < ix.progress.total ? ix.progress : null }, node: process.versions.node };
    },

    /**
     * Tests a model from the PC exactly as the agent calls it (model details, then a tiny chat with
     * tools), with the settings in the form (`raw`, as AI settings stores them) or the saved ones.
     */
    async checkModel(raw: unknown, which: ModelChoice) {
      const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : store.get().ai;
      const model = modelSettings(src, which);
      if (!model) return { ok: false, message: which === 'second' ? 'No second model is set up.' : 'No model is set up.' };
      const signal = AbortSignal.timeout(90_000);
      const started = Date.now();
      try {
        const caps = await detectCapabilities(model, signal, true);
        const res = await chatStep(model, {
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          tools: caps.tools === 'native' ? [{ name: 'update_plan', description: 'Not needed for this message.', parameters: { type: 'object', properties: {} } }] : [],
          mode: 'native',
          signal,
        });
        return {
          ok: true,
          message: `The PC reached ${model.textModel} in ${((Date.now() - started) / 1000).toFixed(1)} s (${caps.tools === 'native' ? 'native tool calls' : 'tools through prompts'}, ${Math.round(caps.contextTokens / 1000)}k context).${caps.warning ? ` Note: ${caps.warning}` : ''}`,
          reply: res.content.slice(0, 200),
        };
      } catch (e) {
        const message = e instanceof ModelError || e instanceof Error ? e.message : String(e);
        console.error(`[agent] check of ${model.provider} ${model.baseUrl} (${model.textModel}) failed: ${message}`);
        return { ok: false, message };
      }
    },

    start(req: RunRequest): AgentRun {
      const model = modelSettings(store.get().ai, req.model);
      if (!model) {
        throw new AgentUnavailable(
          req.model === 'second'
            ? 'No second model is set up: add one in AI settings (e.g. OpenRouter), or switch back to the main model.'
            : 'The AI is not set up yet: choose a model in AI settings.',
        );
      }
      prune();
      const settings = this.settings();
      // Auto mode's reviewer: the model doing the task, or the one chosen in the agent settings.
      const chosen = settings.reviewer === 'same' || settings.reviewer === req.model ? null : modelSettings(store.get().ai, settings.reviewer);
      const run = new AgentRun(req);
      runs.set(run.id, run);
      void runAgent(run, { model, reviewer: chosen ?? model, settings, index: indexes.get(req.rootId, req.rootPath), dataDir: store.dataDir });
      return run;
    },

    get(id: string): AgentRun | undefined {
      return runs.get(id);
    },

    stopAll() {
      for (const r of runs.values()) if (!r.finishedAt) r.stop();
    },

    dataDir: path.resolve(store.dataDir),
  };
}

export type AgentService = ReturnType<typeof createAgentService>;
