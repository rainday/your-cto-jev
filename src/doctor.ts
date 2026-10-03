import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agents } from './agents.js';
import { probeProvider, providers } from './api.js';
import { loadBrain, loadConfig, loadCredentials } from './brain.js';
import { AGENT_TIMEOUT_MS } from './hooks.js';
import { t, type Lang } from './i18n.js';
import { wiredAgents } from './setup.js';
import { checkUpdate, currentVersion } from './update.js';

function hint(provider: string, status: string): string {
  if (status === '401') return provider === 'cloudflare' ? 'doc_hint_cf_401' : 'doc_hint_401';
  if (status === '403') return provider === 'cloudflare' ? 'doc_hint_cf_403' : 'doc_hint_401';
  if (status === '402') return 'doc_hint_402';
  if (status === 'timeout' || status === 'network') return 'doc_hint_network';
  return 'doc_hint_other';
}

/** One screen answering "is cto actually working here?". Exit 1 when it is not. */
export async function doctor(cwd: string, lang: Lang): Promise<{ code: number; lines: string[] }> {
  const L: string[] = [];
  const problems: string[] = [];
  const latest = await checkUpdate();
  L.push(t(lang, 'doc_version', { v: currentVersion() }) + (latest ? '  ' + t(lang, 'update_available', { latest, current: currentVersion() }) : ''));

  // Keys and a live probe per provider
  L.push('', t(lang, 'doc_keys'));
  const file = loadCredentials() as Record<string, string | undefined>;
  let working = 0;
  for (const name of Object.keys(providers)) {
    const label = providers[name].label;
    const missing = providers[name].keys.filter((k) => !process.env[k]);
    if (missing.length) {
      L.push(`  - ${label}: ${t(lang, 'doc_not_set', { keys: missing.join(', ') })}`);
      continue;
    }
    const fromFile = providers[name].keys.every((k) => file[k] && file[k] === process.env[k]);
    const source = t(lang, fromFile ? 'doc_src_file' : 'doc_src_env');
    const start = performance.now();
    const r = await probeProvider(name);
    const ms = Math.round(performance.now() - start);
    if (r.ok) {
      working++;
      const slow = ms > AGENT_TIMEOUT_MS;
      L.push(`  ${slow ? '!!' : 'OK'} ${label} (${source}): ${t(lang, 'doc_ok', { ms })}${slow ? '  ' + t(lang, 'doc_slow', { limit: AGENT_TIMEOUT_MS / 1000 }) : ''}`);
      if (slow) problems.push(t(lang, 'doc_slow', { limit: AGENT_TIMEOUT_MS / 1000 }));
    } else {
      L.push(`  !! ${label} (${source}): ${t(lang, 'doc_fail', { status: r.status })} ${r.message ?? ''}`.trimEnd());
      L.push(`     ${t(lang, hint(name, r.status))}`);
      problems.push(t(lang, 'doc_p_provider', { name: label }));
    }
  }
  if (!working) problems.unshift(t(lang, 'doc_p_no_provider'));

  // Current repository
  let root: string | undefined;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a repo */ }
  if (!root) {
    L.push('', t(lang, 'doc_no_repo'));
  } else {
    L.push('', t(lang, 'doc_repo', { root }));
    const hooksDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8' }).trim();
    const hookPath = join(hooksDir, 'pre-commit');
    const hook = existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : '';
    if (hook.includes('YOUR CTO JEV START')) L.push(`  OK ${t(lang, 'doc_hook_ok', { path: hookPath })}`);
    else { L.push(`  !! ${t(lang, 'doc_hook_missing')}`); problems.push(t(lang, 'doc_hook_missing')); }

    const wired = wiredAgents(root);
    L.push(`  ${wired.length ? 'OK' : '--'} ${t(lang, 'doc_agents', { list: wired.map((n) => agents[n].label).join(', ') || t(lang, 'doc_none') })}`);

    const cfg = loadConfig(root);
    L.push(`  -- ${t(lang, cfg.sprint_goal.trim() ? 'doc_goal_set' : 'doc_goal_empty')}`);

    const brain = loadBrain(root);
    L.push(`  -- ${t(lang, 'doc_stats', { blocked: brain.blocked_attempts, skipped: brain.skipped_attempts })}`);
    for (const [p, cd] of Object.entries(brain.provider_cooldown)) {
      if (cd.until > Date.now()) L.push(`  !! ${t(lang, 'doc_cooldown', { name: providers[p]?.label ?? p, status: cd.status, until: new Date(cd.until).toLocaleTimeString() })}`);
    }
  }

  L.push('');
  if (problems.length) {
    L.push(t(lang, 'doc_bad'));
    for (const p of problems) L.push(`  - ${p}`);
  } else {
    L.push(t(lang, 'doc_good'));
  }
  return { code: problems.length ? 1 : 0, lines: L };
}
