import type { BookProject } from './types.js';

export type FrictionMode = 'off' | 'natural' | 'my-voice' | 'write-as-me' | 'raw';
export interface FrictionConfig { mode: FrictionMode; samples?: string[]; authorNotes?: string; }

/** A constrained, optional inference pass. Never invent an author's experiences or beliefs. */
export async function applyFrictionWrite(
  generate: (request: Record<string, unknown>) => Promise<{text: string}>,
  book: BookProject,
  chapterNumber: number,
  draft: string,
  config: FrictionConfig,
): Promise<string> {
  if (config.mode === 'off') return draft;
  const samples = (config.samples || []).filter(s => s.trim().length >= 80).slice(0, 5);
  if ((config.mode === 'my-voice' || config.mode === 'write-as-me') && !samples.length) {
    throw new Error('FrictionWrite requires an author writing sample for this mode');
  }
  const instructions = [
    'You are FrictionWrite, a constrained literary revision engine. Return only revised prose.',
    'Preserve all events, facts, named entities, plot continuity, point of view, dialogue intent, and chapter boundaries.',
    'Do not add autobiographical details, opinions, beliefs, or experiences not established by the source.',
    'Remove generic AI-like filler, redundant explanations, uniform transitions, and needless recaps only where warranted.',
    'Vary cadence organically; do not inject random errors, awkwardness, or artificial entropy.',
    config.mode === 'raw' ? 'Retain deliberate rough edges, fragments, and sharp transitions.' : '',
    config.mode === 'natural' ? 'Prioritize natural literary flow without imposing an invented author identity.' : '',
    config.mode === 'my-voice' || config.mode === 'write-as-me' ? 'Use supplied samples as style evidence, not text to copy.' : '',
    config.mode === 'write-as-me' ? 'Use only explicitly evidenced positions and reasoning habits; where unsupported, retain the draft position.' : '',
  ].filter(Boolean).join(' ');
  const result = await generate({
    profile: 'reasoning', system: instructions,
    prompt: JSON.stringify({ title: book.title, tone: book.tone, chapterNumber, mode: config.mode,
      authorSamples: samples, authorNotes: config.authorNotes || '', source: draft }),
    maxOutputTokens: Math.max(2500, Math.ceil(draft.length / 2)),
    telemetry: { sessionId: `${book.id}:chapter:${chapterNumber}`, agentId: 'frictionwrite' },
  });
  let output = result.text.trim();
  // Some inference providers wrap the revised chapter in a JSON object.
  // Never persist that envelope as manuscript prose.
  const candidate = output.startsWith('```')
    ? output.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
    : output;
  if (candidate.startsWith('{')) {
    let parsed: unknown;
    try { parsed = JSON.parse(candidate); }
    catch { throw new Error('FrictionWrite returned malformed JSON instead of chapter prose'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).revisedProse !== 'string') {
      throw new Error('FrictionWrite returned JSON without a revisedProse string');
    }
    output = ((parsed as Record<string, unknown>).revisedProse as string).trim();
  }
  if (!output || output.length < draft.length * 0.65 || output.length > draft.length * 1.5) {
    throw new Error('FrictionWrite revision failed basic length validation');
  }
  return output;
}
