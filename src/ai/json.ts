// Structured answers: ask for JSON, parse it, validate it, retry once. Nothing unvalidated is used.

import { AiError, chat, type ChatMessage } from './client';
import type { AiSettings } from './settings';

/** Thrown by validators; the message is shown to the model on the retry. */
export class InvalidAnswer extends Error {}

/** Parses the JSON object in a model answer (tolerates ``` fences and text around it). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new InvalidAnswer('The answer contains no JSON object.');
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new InvalidAnswer(`The JSON is malformed: ${(e as Error).message}`);
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An array field of the answer object (missing = empty). */
export function arrayField(v: unknown, field: string): unknown[] {
  if (!isObj(v)) throw new InvalidAnswer('The answer must be a JSON object.');
  const a = v[field] ?? [];
  if (!Array.isArray(a)) throw new InvalidAnswer(`"${field}" must be an array.`);
  return a;
}

export async function askJson<T>(
  s: AiSettings,
  o: { messages: ChatMessage[]; schema: object; validate: (v: unknown) => T; signal?: AbortSignal; vision?: boolean },
): Promise<T> {
  let messages = o.messages;
  for (let attempt = 0; ; attempt++) {
    const answer = await chat(s, { messages, schema: o.schema, signal: o.signal, vision: o.vision });
    try {
      return o.validate(extractJson(answer));
    } catch (e) {
      if (!(e instanceof InvalidAnswer)) throw e;
      if (attempt >= 1) {
        throw new AiError('The model gave an answer NoteTOO could not use. Try again, or pick a bigger model in AI settings.');
      }
      messages = [
        ...o.messages,
        { role: 'assistant', content: answer.slice(0, 4000) },
        { role: 'user', content: `That answer was invalid: ${e.message} Reply again with ONLY a JSON object matching this schema: ${JSON.stringify(o.schema)}` },
      ];
    }
  }
}
