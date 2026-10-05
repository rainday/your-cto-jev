import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { maskSensitiveState } from './masker.js';
import { shellWrites } from './shellwrites.js';

// Reads a Claude Code transcript (JSONL) and summarises the current turn for the end-of-turn "done?" check.

export type Action = { kind: 'edit'; file: string } | { kind: 'run'; command: string; ok: boolean; tail: string };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Edits that no local test could check: docs, CI and other YAML config.
const NON_CODE = /(\.(md|mdx|txt|rst|adoc|ya?ml)$)|(^|[\\/])\.github[\\/]/i;
export const isCodeFile = (f: string) => !NON_CODE.test(f);

const isHumanTurn = (j: any) => {
  // Claude Code writes meta entries (image notes, skill text, compact summaries) as type "user" mid-turn.
  if (j?.type !== 'user' || j.isMeta || j.isCompactSummary) return false;
  const c = j.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
};

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
};
const tailOf = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? '…' + flat.slice(-max) : flat;
};

/** Actions since the last human message, oldest first. Unreadable or partial transcripts give what could be parsed. */
export function turnActions(transcriptPath: string, cwd?: string): Action[] {
  let lines: any[] = [];
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').flatMap((l) => {
      try { return l ? [JSON.parse(l)] : []; } catch { return []; }
    });
  } catch { return []; }
  let start = 0;
  lines.forEach((j, i) => { if (isHumanTurn(j)) start = i + 1; });

  const results = new Map<string, { ok: boolean; text: string }>();
  for (const j of lines.slice(start)) {
    const c = j?.type === 'user' ? j.message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join(' ') : '';
      results.set(b.tool_use_id, { ok: !b.is_error, text });
    }
  }

  const actions: Action[] = [];
  for (const j of lines.slice(start)) {
    const c = j?.type === 'assistant' ? j.message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b?.type !== 'tool_use') continue;
      if (EDIT_TOOLS.has(b.name)) {
        const p = String(b.input?.file_path ?? b.input?.notebook_path ?? '');
        if (p) actions.push({ kind: 'edit', file: cwd ? relative(cwd, p) || p : p });
      } else if (b.name === 'Bash' || b.name === 'PowerShell') {
        const r = results.get(b.id);
        if (!r) continue; // not finished (or transcript lagging): no evidence either way
        const command = String(b.input?.command ?? '');
        // A successful shell command that writes files is an edit too (sed -i, redirects, formatters). Listed before
        // the run itself, since in "sed -i ... && npm test" the write happens before the test.
        if (r.ok) for (const f of shellWrites(command)) actions.push({ kind: 'edit', file: f === '?' ? `(files written by: ${oneLine(command, 60)})` : f });
        actions.push({ kind: 'run', command, ok: r.ok, tail: r.text });
      }
    }
  }
  return actions;
}

/** The text Jev sees: final message, the action log, and the one fact code can compute exactly. Masked. */
export function turnState(lastMessage: string, actions: Action[]): string {
  // The fact is computed over the whole turn; only the log shown to Jev is trimmed.
  let lastEdit = -1;
  actions.forEach((a, i) => { if (a.kind === 'edit' && isCodeFile(a.file)) lastEdit = i; });
  const after = lastEdit < 0 ? null : actions.slice(lastEdit + 1).flatMap((a) => (a.kind === 'run' ? [oneLine(a.command, 120)] : []));
  const recent = actions.slice(-40);
  const fact = after === null
    ? 'No code files were edited this turn.'
    : after.length ? `Commands that ran after the last code edit: ${after.join('; ')}` : 'No command ran after the last code edit.';
  const log = recent.length
    ? recent.map((a, i) => a.kind === 'edit'
      ? `${i + 1}. edited ${a.file}`
      : `${i + 1}. ran: ${oneLine(a.command, 200)} -> ${a.ok ? 'succeeded' : 'FAILED'}${a.tail ? `\n   output tail: ${tailOf(a.tail, 200)}` : ''}`).join('\n')
    : '(none)';
  return maskSensitiveState(
    `The agent's final message to the user:\n"""\n${tailOf(lastMessage, 1500)}\n"""\n\nActions this turn, in order:\n${log}\n\nFact: ${fact}`,
  );
}
