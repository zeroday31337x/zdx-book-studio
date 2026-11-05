/** Optional, isolated Humanizer completion backend. Never expose the inference URL to clients. */
export async function humanizeWithLocalModel(draft: string): Promise<string> {
  const endpoint = process.env.BOOK_STUDIO_HUMANIZER_URL;
  if (!endpoint) throw new Error('Humanizer backend not configured');
  const url = new URL('/completion', endpoint);
  if (url.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(url.hostname))
    throw new Error('Humanizer endpoint must use an internal network address');
  const instruction = 'Rewrite the text below so it reads like a person wrote it, not a language model.\n\nReorganize it as you see fit. Vary sentence length on purpose. Cut hedging,\nthroat-clearing, and any sentence that only announces what comes next.\nPrefer the concrete word over the abstract one. It is fine to sound uneven.\n\nEvery fact, number, unit, date, name and quotation must survive unchanged.';
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of draft.trim().split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length > 2100) { chunks.push(current); current = ''; }
    if (paragraph.length > 2500) throw new Error('Humanizer input contains an oversized paragraph');
    current += (current ? '\n\n' : '') + paragraph;
  }
  if (current) chunks.push(current);
  const results: string[] = [];
  for (const chunk of chunks) {
    const response = await fetch(url, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      signal: AbortSignal.timeout(900000),
      body: JSON.stringify({prompt: instruction + '\n\n' + chunk + '\n\n### Rewritten:\n\n', temperature: 1, top_p: 0.95, top_k: 0, min_p: 0, repeat_penalty: 1, n_predict: 1500, stream: false})
    });
    if (!response.ok) throw new Error('Humanizer inference failed: ' + response.status);
    const payload = await response.json() as {content?: string};
    const prose = payload.content?.trim() || '';
    if (prose.length < chunk.length * 0.65 || prose.length > chunk.length * 1.5)
      throw new Error('Humanizer output failed length validation');
    results.push(prose);
  }
  return results.join('\n\n');
}
