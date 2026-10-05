#!/usr/bin/env node
// Pull real shell commands that coding agents ran from a public trajectory dataset, as unlabeled candidates for the
// destructive_command calibration set. A human labels them (expect: true/false); calibrate.mjs ignores unlabeled ones.
//
//   node scripts/harvest-commands.mjs [--rows 300] [--offset 0]
//
// Source: nebius/SWE-rebench-openhands-trajectories (CC-BY-4.0), via the Hugging Face datasets-server rows API.
// Only the command strings are kept, with the instance id for attribution.
import { mkdirSync, writeFileSync } from 'node:fs';

const DATASET = 'nebius/SWE-rebench-openhands-trajectories';
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? Number(process.argv[i + 1]) : d; };
const rows = arg('--rows', 300), offset = arg('--offset', 0);

// Commands worth a reviewer's look: anything that deletes, overwrites, rewrites history or changes permissions.
const RISKY = /\brm\s|\bgit\s+(reset|clean|push|checkout\s+--|restore|rebase|branch\s+-D|stash\s+drop)|\bfind\b.*-delete|\btruncate\b|\bdd\s|\bmkfs|\bchmod\s+-R|\bchown\s+-R|\bdrop\s+(table|database)|>\s*\/(etc|usr|bin)|\bkill\s+-9|\bpkill\b|\bmv\s/i;

const seen = new Set();
const risky = [], plain = [];
for (let at = offset; at < offset + rows; at += 100) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=train&offset=${at}&length=${Math.min(100, offset + rows - at)}`;
  const res = await fetch(url);
  if (!res.ok) { console.error(`HTTP ${res.status} at offset ${at}`); break; }
  for (const { row } of (await res.json()).rows ?? []) {
    for (const m of row.trajectory ?? []) {
      for (const c of m.tool_calls ?? []) {
        if (c.function?.name !== 'execute_bash') continue;
        let cmd;
        try { cmd = JSON.parse(c.function.arguments).command; } catch { continue; }
        if (typeof cmd !== 'string') continue;
        // Drop the per-task "cd /workspace/<repo> &&" prefix so identical commands dedupe across tasks.
        cmd = cmd.replace(/^cd\s+\/workspace\/\S+\s*&&\s*/, '').trim();
        if (!cmd || cmd.length > 300 || seen.has(cmd)) continue;
        seen.add(cmd);
        (RISKY.test(cmd) ? risky : plain).push({ instance: row.instance_id, command: cmd });
      }
    }
  }
}

// Keep every risky command and an equal-sized spread of ordinary ones as negatives.
const step = Math.max(1, Math.floor(plain.length / Math.max(1, risky.length)));
const picked = [...risky, ...plain.filter((_, i) => i % step === 0).slice(0, risky.length)];
const out = new URL('../calibration/candidates/', import.meta.url);
mkdirSync(out, { recursive: true });
const lines = picked.map((c, i) => JSON.stringify({ id: `oh-${offset}-${i}`, set: 'holdout', expect: null, source: `${DATASET} (CC-BY-4.0) ${c.instance}`, command: c.command }));
writeFileSync(new URL('destructive_command.jsonl', out), lines.join('\n') + '\n');
console.log(`${seen.size} unique commands from ${rows} trajectories; wrote ${risky.length} risky + ${picked.length - risky.length} ordinary candidates to calibration/candidates/destructive_command.jsonl`);
