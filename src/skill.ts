import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentName } from './agents.js';

// Guidance for coding agents, in two layers:
// 1. A short rules block in each agent's always-loaded project file (CLAUDE.md, AGENTS.md, GEMINI.md). Skills load
//    only when the agent decides they are relevant, so rules that must always hold live here.
// 2. One detailed skill at .agents/skills/cto (read by Codex, Gemini CLI and Cursor; the rules block points Claude
//    Code to the same file). A single copy, so Cursor (which also scans .claude/skills) never sees two.
// Every rule names the check that enforces it, and every enforcing check has a rule.

export const SKILL_MARK = '<!-- Managed by `cto setup`. Re-run it to update; local edits are overwritten. -->';
export const SKILL_PATH = '.agents/skills/cto/SKILL.md';
const LEGACY_SKILL = '.claude/skills/cto/SKILL.md'; // 0.5.0 pre-release layout, cleaned up on sync

const MD_START = '<!-- >>> YOUR CTO JEV START >>> -->';
const MD_END = '<!-- <<< YOUR CTO JEV END <<< -->';
const mdBlockRe = /\n?<!-- >>> YOUR CTO JEV START >>> -->\n[\s\S]*?<!-- <<< YOUR CTO JEV END <<< -->\n?/;

export const MEMORY_FILES: { path: string; agents: AgentName[] }[] = [
  { path: 'CLAUDE.md', agents: ['claude'] },
  { path: 'AGENTS.md', agents: ['codex', 'cursor'] },
  { path: 'GEMINI.md', agents: ['gemini'] },
];

export const RULES_BLOCK = `${MD_START}
## Rules enforced by cto

This repo is guarded by cto: every rule below is checked automatically, and breaking one gets you blocked.

- **Secrets stay out of code.** Use environment variables, never literal keys, tokens or passwords. (\`credential_leak\` blocks the commit)
- **Fix the code, not the tests.** Never skip, delete or loosen a test, rewrite an expectation to match wrong output, or lower coverage. (\`test_tampering\` blocks the commit)
- **Done means verified.** After your last code change, run the relevant tests or build and see them pass before saying done; otherwise say what is unverified. (\`done_unverified\` sends you back)
- **Two strikes, change approach.** Same command, same error twice: stop retrying and try something different. (\`infinite_loop\` blocks the retry)
- **Ask before anything irreversible:** deleting data, force-pushing, rewriting history, dropping a database. (\`destructive_command\` blocks it)
- **Stay on the sprint goal in \`.cto.json\` and keep changes simple.** (\`architecture_violation\` and \`code_complexity\` warn)
- **Run \`cto check\` before committing**, and never bypass a block (\`--no-verify\`, editing hooks or thresholds). If a block looks wrong, tell the user.

Details and how to handle a block: \`${SKILL_PATH}\`.
${MD_END}
`;

export const SKILL_TEXT = `---
name: cto
description: Development rules enforced in this repository by the cto gatekeeper, with what each check looks for and what to do when blocked. Use before committing, before saying a task is done, after a command fails, before running anything destructive, and whenever a cto hook blocks you.
---
${SKILL_MARK}

# cto: the rules of this repo

This repository is guarded by **cto** (your-cto-jev). Hooks review your commits and commands with a decision model.
Each rule below has a check behind it. Following the rules is faster than being blocked.

| Rule | What enforces it |
|---|---|
| **Secrets stay out of code.** Never write API keys, tokens, passwords or private keys into code or committed files. Read them from environment variables. | \`credential_leak\` blocks the commit |
| **Fix the code, not the tests.** When a test fails, change the code under test. Never skip, comment out or delete a test, loosen an assertion, change an expected value to match wrong output, swallow the error, or lower a coverage threshold. A test may only go away together with the feature it covers, and you say so. | \`test_tampering\` blocks the commit |
| **Done means verified.** After your last code change, run the relevant tests, build or type check and see it pass before you say the work is done. If you cannot, say plainly what is not verified and why. | \`done_unverified\` sends you back to work |
| **Two strikes, change approach.** If a command fails with the same error twice, stop retrying. Read the error, inspect the code, and try something different. | \`infinite_loop\` blocks the retry once |
| **Ask before anything irreversible.** Get the user's explicit OK before deleting data outside build output, force-pushing, rewriting shared history, or dropping a database. | \`destructive_command\` blocks the command |
| **Stay on the sprint goal.** If \`.cto.json\` sets a \`sprint_goal\`, keep changes inside it and point out anything unrelated. | \`architecture_violation\` warns |
| **Keep it simple.** Prefer the smallest change that solves the problem. | \`code_complexity\` warns |

## Before you commit

Run \`cto check\`. It runs the same commit checks on your staged changes (or, if nothing is staged, on all working-tree
changes including new files) without committing, and prints every score with its threshold. Fix anything it flags,
then commit. If \`cto\` is not installed on this machine, skip this step.

## When cto blocks you

Read the message, fix the cause, and try again. Never bypass a block: no \`git commit --no-verify\`, no disabling or
editing hooks, no changing \`.cto.json\` thresholds to get through. If you believe a block is wrong, stop and tell the
user what was blocked and why you disagree; the user decides.

## Commands

- \`cto check\`: preview the commit checks on your current changes.
- \`cto doctor\`: show whether cto is working here (keys, hooks, recent checks).
`;

// Removes exactly what appendMd added: the block, its trailing newline, and the one blank separator line before it.
const removeMd = (s: string) => s.replace(mdBlockRe, '');
const appendMd = (s: string) => {
  const base = removeMd(s);
  return (base && !base.endsWith('\n') ? base + '\n' : base) + (base.trim() ? '\n' : '') + RULES_BLOCK;
};

function removeFileAndEmptyDirs(root: string, path: string) {
  unlinkSync(path);
  for (let d = dirname(path), i = 0; i < 3 && !relative(root, d).startsWith('..') && relative(root, d) !== ''; i++, d = dirname(d)) {
    try { if (readdirSync(d).length) break; rmdirSync(d); } catch { break; }
  }
}

/**
 * Bring guidance in line with the chosen agents: write/refresh the rules block and the skill for them; with
 * removeOthers (exact mode or uninstall) take cto's content out of files no chosen agent reads. Only cto-marked
 * content is ever removed or overwritten.
 */
export function syncGuidance(root: string, chosen: Set<AgentName>, removeOthers: boolean): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const m of MEMORY_FILES) {
    const path = join(root, m.path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (m.agents.some((a) => chosen.has(a))) {
      const next = appendMd(current);
      if (next !== current) { writeFileSync(path, next); written.push(m.path); }
    } else if (removeOthers && mdBlockRe.test(current)) {
      const rest = removeMd(current);
      if (rest.trim()) writeFileSync(path, rest); else unlinkSync(path);
      removed.push(m.path);
    }
  }
  const skill = join(root, SKILL_PATH);
  if (chosen.size) {
    if (!existsSync(skill) || readFileSync(skill, 'utf8') !== SKILL_TEXT) {
      mkdirSync(dirname(skill), { recursive: true });
      writeFileSync(skill, SKILL_TEXT);
      written.push(SKILL_PATH);
    }
  } else if (removeOthers && existsSync(skill) && readFileSync(skill, 'utf8').includes(SKILL_MARK)) {
    removeFileAndEmptyDirs(root, skill);
    removed.push(SKILL_PATH);
  }
  const legacy = join(root, LEGACY_SKILL);
  if (existsSync(legacy) && readFileSync(legacy, 'utf8').includes(SKILL_MARK)) removeFileAndEmptyDirs(root, legacy);
  return { written, removed };
}

/** Guidance files that are missing or differ from what this version would write, for the given agents. */
export function staleGuidance(root: string, agentsInUse: AgentName[]): string[] {
  if (!agentsInUse.length) return [];
  const stale: string[] = [];
  for (const m of MEMORY_FILES) {
    if (!m.agents.some((a) => agentsInUse.includes(a))) continue;
    const path = join(root, m.path);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (!current.includes(RULES_BLOCK.trimEnd())) stale.push(m.path);
  }
  const skill = join(root, SKILL_PATH);
  if (!existsSync(skill) || readFileSync(skill, 'utf8') !== SKILL_TEXT) stale.push(SKILL_PATH);
  return stale;
}
