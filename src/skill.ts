import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentName } from './agents.js';

// The cto skill: the development rules of this repo, written for coding agents. Every rule names the check that
// enforces it, and every enforcing check has a rule here, so an agent knows the rules before it gets blocked.
// One text, two locations: Claude Code reads .claude/skills; Codex, Gemini CLI and Cursor read .agents/skills.

export const SKILL_MARK = '<!-- Managed by `cto setup`. Re-run it to update; local edits are overwritten. -->';

export const SKILL_LOCATIONS: { path: string; agents: AgentName[] }[] = [
  { path: '.claude/skills/cto/SKILL.md', agents: ['claude'] },
  { path: '.agents/skills/cto/SKILL.md', agents: ['codex', 'gemini', 'cursor'] },
];

export const SKILL_TEXT = `---
name: cto
description: Development rules enforced in this repository by the cto gatekeeper. Use before committing, before saying a task is done, after a command fails, before running anything destructive, and whenever a cto hook blocks you.
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

/** Write the skill for the chosen agents; in exact mode (or uninstall) remove copies no chosen agent reads. */
export function syncSkills(root: string, chosen: Set<AgentName>, removeOthers: boolean): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const loc of SKILL_LOCATIONS) {
    const path = join(root, loc.path);
    if (loc.agents.some((a) => chosen.has(a))) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, SKILL_TEXT);
      written.push(loc.path);
    } else if (removeOthers && existsSync(path) && readFileSync(path, 'utf8').includes(SKILL_MARK)) {
      unlinkSync(path);
      // tidy the folders we created (skills/cto, skills, and .agents) only when they are now empty
      for (let d = dirname(path), i = 0; i < 3 && !relative(root, d).startsWith('..') && relative(root, d) !== ''; i++, d = dirname(d)) {
        try { if (readdirSync(d).length) break; rmdirSync(d); } catch { break; }
      }
      removed.push(loc.path);
    }
  }
  return { written, removed };
}
