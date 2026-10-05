import { execFileSync } from 'node:child_process';
import { loadBrain, loadConfig, saveBrain } from './brain.js';
import { BLOCKING_COMMIT, DIFF_ARGS, WARNING_COMMIT, reviewDiff } from './hooks.js';
import { personaDict, t, type Lang } from './i18n.js';
import type { Signal } from './types.js';

const PINNED = DIFF_ARGS.filter((a) => a !== 'diff' && a !== '--cached');
const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * What a commit would contain: the staged changes if anything is staged, otherwise every working-tree change,
 * including new files git does not track yet (agents create those often). Read-only: the index is never touched.
 */
export function pendingDiff(root: string): { diff: string; source: 'staged' | 'working' } {
  const staged = git(root, DIFF_ARGS);
  if (staged.trim()) return { diff: staged, source: 'staged' };
  let diff = git(root, ['diff', ...PINNED]);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of untracked) {
    try {
      diff += git(root, ['diff', '--no-index', ...PINNED, '--', '/dev/null', f]);
    } catch (e: any) {
      diff += String(e?.stdout ?? ''); // --no-index exits 1 when the files differ, which is always here
    }
  }
  return { diff, source: 'working' };
}

/** `cto check`: the commit checks, run now, with every score shown. Exit 1 when a commit would be blocked. */
export async function runCheck(root: string, lang: Lang): Promise<{ code: number; lines: string[] }> {
  const cfg = loadConfig(root);
  const brain = loadBrain(root);
  const { diff, source } = pendingDiff(root);
  const review = await reviewDiff(diff, cfg, brain, lang);
  saveBrain(root, brain); // provider cooldowns only; check runs are not counted as blocks
  if (!review) return { code: 0, lines: [t(lang, 'check_nothing')] };

  const lines = [t(lang, source === 'staged' ? 'check_head_staged' : 'check_head_working', { files: review.files }), ...review.notices];
  if (!Object.keys(review.scores).length) {
    lines.push(t(lang, 'check_unchecked'));
    return { code: 0, lines };
  }
  let code = 0;
  const verdicts: string[] = [];
  const width = Math.max(...[...BLOCKING_COMMIT, ...WARNING_COMMIT].map((s) => s.length));
  for (const s of [...BLOCKING_COMMIT, ...WARNING_COMMIT] as Signal[]) {
    const blocking = BLOCKING_COMMIT.includes(s);
    const v = review.scores[s];
    const name = s.padEnd(width);
    if (v === undefined) {
      const why = s === 'test_tampering' ? 'check_why_tests' : s === 'architecture_violation' ? 'check_why_goal' : 'check_why_failed';
      lines.push(`  ${name}  ${t(lang, why)}`);
      continue;
    }
    const limit = cfg.thresholds[s];
    const bad = v > limit;
    const status = bad ? t(lang, blocking ? 'check_block' : 'check_warn') : 'ok';
    lines.push(`  ${name}  ${String(v).padEnd(5)}  ${t(lang, blocking ? 'check_limit_block' : 'check_limit_warn', { limit })}  ${status}`);
    if (bad) {
      verdicts.push(`[cto] ${personaDict[lang][s]}`);
      if (blocking) code = 1;
    }
  }
  if (review.failed) lines.push(t(lang, 'check_partial'));
  lines.push(...verdicts, code ? t(lang, 'check_result_block') : t(lang, 'check_result_ok'));
  return { code, lines };
}
