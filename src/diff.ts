// Large diff handling (spec section 6): filter noise, then chunk by file.

const EXCLUDE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.min\.js$|\.map$/;
export const CHUNK_TOKENS = 24_000;

/** ~1 token per CJK char, ~4 chars per token otherwise. */
export function estimateTokens(s: string): number {
  const cjk = s.match(/[　-鿿가-힯豈-﫿＀-￯]/g)?.length ?? 0;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

export function splitFiles(diff: string): string[] {
  return diff.split(/^(?=diff --git )/m).filter((s) => s.trim());
}

export function filterDiff(diff: string): string[] {
  return splitFiles(diff).filter((section) => {
    const m = /^diff --git a\/.+? b\/(.+)$/m.exec(section);
    if (m && EXCLUDE.test(m[1])) return false;
    return !/^(Binary files .* differ|GIT binary patch)$/m.test(section);
  });
}

/** Greedy pack of file sections into chunks. A single oversized file is split by lines: no sampling. */
export function chunkDiff(files: string[], limit = CHUNK_TOKENS): string[] {
  const pieces: string[] = [];
  for (const f of files) {
    if (estimateTokens(f) <= limit) { pieces.push(f); continue; }
    // Repeat the file header on every piece so Jev always knows which file (.env vs .env.example) it sees.
    const [header, ...rest] = f.split('\n');
    let buf = header + '\n';
    for (const line of rest) {
      if (buf !== header + '\n' && estimateTokens(buf + line) > limit) { pieces.push(buf); buf = header + '\n'; }
      buf += line + '\n';
    }
    if (buf) pieces.push(buf);
  }
  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces) {
    if (cur && estimateTokens(cur + p) > limit) { chunks.push(cur); cur = ''; }
    cur += p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Run tasks with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
