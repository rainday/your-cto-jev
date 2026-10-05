import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { agentNames, agents, hookCommand, type AgentName } from './agents.js';
import { t, type Lang } from './i18n.js';
import { syncGuidance } from './skill.js';

const START = '# >>> YOUR CTO JEV START >>>';
const END = '# <<< YOUR CTO JEV END <<<';
// Keep the block minimal: all logic (including the git diff call) lives in the package, so npm update upgrades every repo.
const HOOK_BODY = 'if command -v cto >/dev/null 2>&1; then\n  cto --hook git-commit || exit 1\nfi\n';
const IGNORE_BODY = '.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n';
const OURS = (cmd?: unknown) => typeof cmd === 'string' && cmd.startsWith('cto --hook ');

const block = (body: string) => `${START}\n${body}${END}\n`;
const blockRe = /\n?# >>> YOUR CTO JEV START >>>\n[\s\S]*?# <<< YOUR CTO JEV END <<<\n?/;

export function removeBlock(content: string): string {
  return content.replace(blockRe, (m) => (m.startsWith('\n') && m.endsWith('\n') ? '\n' : ''));
}

export function appendBlock(content: string, body: string): string {
  const base = removeBlock(content);
  return (base && !base.endsWith('\n') ? base + '\n' : base) + block(body);
}

/** An exit 0 outside our block means the appended block never runs. */
export function hasEarlyExit(content: string): boolean {
  return /^\s*exit\s+0\b/m.test(removeBlock(content));
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Hooks dir honoring core.hooksPath (via --git-path). Husky's generated .husky/_ is replaced on install, so use .husky. */
export function hooksDir(root: string): string {
  const dir = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
  return basename(dir) === '_' && basename(dirname(dir)) === '.husky' ? dirname(dir) : dir;
}

/** Agents whose home config dir exists. */
export function detectAgents(home = homedir()): AgentName[] {
  return agentNames.filter((n) => existsSync(join(home, agents[n].homeDir)));
}

function readSettings(path: string): any | null {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const isObj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Settings must be an object; the hook events cto writes must be arrays if present. Checked before anything is written. */
function validShape(json: any, name: AgentName): boolean {
  if (!isObj(json)) return false;
  if (json.hooks === undefined) return true;
  if (!isObj(json.hooks)) return false;
  const a = agents[name];
  return [a.pre, a.post, a.stop, a.edit].every((spec) => !spec || json.hooks[spec.event] === undefined || Array.isArray(json.hooks[spec.event]));
}

function writeOrRemove(path: string, settings: any) {
  const meaningful = Object.keys(settings).filter((k) => k !== 'version');
  if (meaningful.length) return writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
  unlinkSync(path);
  try { if (!readdirSync(dirname(path)).length) rmdirSync(dirname(path)); } catch { /* keep dir */ }
}

function installAgent(settings: any, name: AgentName) {
  const a = agents[name];
  settings.hooks ??= {};
  if (a.style === 'cursor') settings.version ??= 1;
  for (const phase of ['pre', 'post', 'stop', 'edit'] as const) {
    const spec = a[phase];
    if (!spec) continue;
    const command = hookCommand(name, phase);
    const arr: any[] = (settings.hooks[spec.event] ??= []);
    if (a.style === 'cursor') {
      if (!arr.some((h) => h?.command === command)) arr.push({ command });
    } else if (!arr.some((m) => m?.hooks?.some((h: any) => h?.command === command))) {
      arr.push({ ...(spec.matcher && { matcher: spec.matcher }), hooks: [{ type: 'command', command }] });
    }
  }
}

/** Remove every cto hook from a settings object (both styles). Returns whether anything changed. */
function uninstallHooks(settings: any): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') return false;
  let touched = false;
  for (const [event, arr] of Object.entries<any>(settings.hooks)) {
    if (!Array.isArray(arr)) continue;
    const kept = arr.flatMap((m: any) => {
      if (OURS(m?.command)) { touched = true; return []; } // cursor style
      if (!Array.isArray(m?.hooks) || !m.hooks.some((h: any) => OURS(h?.command))) return [m];
      touched = true;
      const hooks = m.hooks.filter((h: any) => !OURS(h?.command));
      return hooks.length ? [{ ...m, hooks }] : [];
    });
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (touched && !Object.keys(settings.hooks).length) delete settings.hooks;
  return touched;
}

export interface SetupOptions {
  uninstall?: boolean;
  agents?: AgentName[];
  /** The agent list is the full desired set (interactive setup): unpicked agents lose their cto hooks. Default: add only. */
  exact?: boolean;
}

export function setup(cwd: string, lang: Lang, opts: SetupOptions = {}): { code: number; lines: string[] } {
  const lines: string[] = [];
  let root: string;
  try { root = git(cwd, 'rev-parse', '--show-toplevel'); } catch { return { code: 1, lines: [t(lang, 'setup_not_git')] }; }
  const rel = (p: string) => relative(root, p) || p;

  // Files we will touch: chosen agents get hooks; in exact mode (and on uninstall) agents that currently have cto hooks
  // lose them. Any other agent's config is never read, so a broken unrelated file cannot block the install.
  const chosen = new Set(opts.uninstall ? [] : (opts.agents ?? []));
  const removing = opts.uninstall || opts.exact ? wiredAgents(root).filter((n) => !chosen.has(n)) : [];
  const targets = [...chosen, ...removing];
  // Validate every config file we may touch before writing anything.
  const settings = new Map<AgentName, { path: string; json: any }>();
  for (const name of targets) {
    const path = join(root, agents[name].settings);
    const json = readSettings(path);
    if (json === null || !validShape(json, name)) return { code: 1, lines: [t(lang, 'setup_bad_json', { path: rel(path) })] };
    settings.set(name, { path, json });
  }

  const hookPath = join(hooksDir(root), 'pre-commit');
  const ignorePath = join(root, '.gitignore');

  if (opts.uninstall) {
    if (existsSync(hookPath)) {
      const c = readFileSync(hookPath, 'utf8');
      if (blockRe.test(c)) {
        const rest = removeBlock(c);
        if (!rest.trim() || rest.trim() === '#!/bin/sh') unlinkSync(hookPath);
        else writeFileSync(hookPath, rest);
        lines.push(t(lang, 'uninstall_hook', { path: rel(hookPath) }));
      }
    }
    for (const [name, { path, json }] of settings) {
      if (!existsSync(path) || !uninstallHooks(json)) continue;
      writeOrRemove(path, json);
      lines.push(t(lang, 'uninstall_agent', { label: agents[name].label, path: rel(path) }));
    }
    if (existsSync(ignorePath)) {
      const c = readFileSync(ignorePath, 'utf8');
      if (blockRe.test(c)) {
        const rest = removeBlock(c);
        if (rest.trim()) writeFileSync(ignorePath, rest);
        else unlinkSync(ignorePath);
        lines.push(t(lang, 'uninstall_gitignore'));
      }
    }
    for (const p of syncGuidance(root, new Set(), true).removed) lines.push(t(lang, 'uninstall_skill', { path: p }));
    lines.push(t(lang, 'uninstall_done'));
    return { code: 0, lines };
  }

  // 1. git pre-commit: covers every agent and humans alike. Append a marked block, never overwrite.
  if (existsSync(hookPath)) {
    const c = readFileSync(hookPath, 'utf8');
    writeFileSync(hookPath, appendBlock(c, HOOK_BODY));
    if (hasEarlyExit(c)) lines.push(t(lang, 'setup_hook_exit', { path: rel(hookPath) }));
  } else {
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, '#!/bin/sh\n' + block(HOOK_BODY));
  }
  chmodSync(hookPath, 0o755);
  lines.push(t(lang, 'setup_hook', { path: rel(hookPath) }));

  // 2. Agent hooks: merge, keep everything else. Agents not chosen lose their cto hooks only.
  for (const [name, { path, json }] of settings) {
    if (!chosen.has(name)) {
      if (existsSync(path) && uninstallHooks(json)) {
        writeOrRemove(path, json);
        lines.push(t(lang, 'uninstall_agent', { label: agents[name].label, path: rel(path) }));
      }
      continue;
    }
    installAgent(json, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    lines.push(t(lang, 'setup_agent', { label: agents[name].label, path: rel(path) }));
    const note = agents[name].note;
    if (note) lines.push(t(lang, note));
  }

  // 2b. The cto skill (rules for the agent), for the chosen agents.
  const skills = syncGuidance(root, chosen, !!opts.exact);
  for (const p of skills.written) lines.push(t(lang, 'setup_skill', { path: p }));
  for (const p of skills.removed) lines.push(t(lang, 'uninstall_skill', { path: p }));

  // 3. .gitignore block.
  writeFileSync(ignorePath, appendBlock(existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '', IGNORE_BODY));
  lines.push(t(lang, 'setup_gitignore'));

  // 4. Shared config, created once and never removed.
  const cfgPath = join(root, '.cto.json');
  let goal = '';
  if (!existsSync(cfgPath)) {
    // Thresholds are left out on purpose: the package defaults apply and improve with each release. Add only overrides.
    writeFileSync(cfgPath, JSON.stringify({ sprint_goal: '', thresholds: {} }, null, 2) + '\n');
    lines.push(t(lang, 'setup_config'));
  } else {
    try { goal = JSON.parse(readFileSync(cfgPath, 'utf8')).sprint_goal ?? ''; } catch { /* keep empty */ }
  }
  if (!String(goal).trim()) lines.push(t(lang, 'setup_sprint'));
  lines.push(t(lang, 'setup_done'));
  return { code: 0, lines };
}

/** Hook phases a wired agent should have but its config lacks (installed by an older version). */
export function missingHooks(root: string): string[] {
  const missing: string[] = [];
  for (const n of wiredAgents(root)) {
    const text = readFileSync(join(root, agents[n].settings), 'utf8');
    for (const phase of ['pre', 'post', 'stop', 'edit'] as const) {
      if (agents[n][phase] && !text.includes(hookCommand(n, phase))) missing.push(hookCommand(n, phase));
    }
  }
  return missing;
}

/** Agents whose config in this repo currently calls cto. */
export function wiredAgents(root: string): AgentName[] {
  return agentNames.filter((n) => {
    const p = join(root, agents[n].settings);
    return existsSync(p) && readFileSync(p, 'utf8').includes('cto --hook ');
  });
}

/** Repo root, or undefined outside a git repo. */
export function gitRoot(cwd: string): string | undefined {
  try { return git(cwd, 'rev-parse', '--show-toplevel'); } catch { return undefined; }
}

/**
 * Set sprint_goal in .cto.json, keeping everything else in the file.
 * Refuses (returns false) when the file exists but is not a JSON object: never overwrite someone's thresholds.
 */
export function setSprintGoal(root: string, goal: string): boolean {
  const path = join(root, '.cto.json');
  let cfg: any = { sprint_goal: '', thresholds: {} };
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  }
  writeFileSync(path, JSON.stringify({ ...cfg, sprint_goal: goal }, null, 2) + '\n');
  return true;
}
