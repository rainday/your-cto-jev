#!/usr/bin/env node
// Re-measure how well each check separates its calibration cases, using exactly the questions and state builders
// that ship (imported from dist/). Run after changing a question, after a Jev model update, or after adding cases.
//
//   npm run calibrate                         all signals
//   npm run calibrate -- --signal infinite_loop
//   npm run calibrate -- --provider openrouter
//
// Needs a working provider key (env or `cto setup`). Each case is one request (~$0.00002 on OpenRouter).
import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const dist = new URL('../dist/', import.meta.url);
const { applyCredentials, DEFAULT_CONFIG } = await import(new URL('brain.js', dist));
const { evaluate, providerOrder } = await import(new URL('api.js', dist));
const { Q, loopState } = await import(new URL('hooks.js', dist));
const { turnState } = await import(new URL('turn.js', dist));
const { maskDiff, maskSensitiveState } = await import(new URL('masker.js', dist));
const { pool } = await import(new URL('diff.js', dist));

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
if (arg('--provider')) process.env.CTO_PROVIDER = arg('--provider');
applyCredentials();
if (!providerOrder().length) { console.error('No Jev provider available. Set a key or run `cto setup`.'); process.exit(1); }

// Fixtures keep secret-shaped values as placeholders so the repo never contains anything that looks like a real key.
const rnd = (n) => randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, 'x').slice(0, n);
const fill = (s) => s
  .replaceAll('{{STRIPE_LIVE}}', 'sk_live_' + rnd(24))
  .replaceAll('{{OPENAI_KEY}}', 'sk-proj-' + rnd(24))
  .replaceAll('{{DB_URL}}', `postgres://admin:${rnd(12)}@db.internal/prod`);

// One state builder per signal: the same text the hooks send.
const STATE = {
  credential_leak: (c) => maskDiff(fill(c.diff)),
  test_tampering: (c) => maskDiff(c.diff),
  destructive_command: (c) => maskSensitiveState(c.command),
  infinite_loop: (c) => loopState(c.command, c.failures.map((f) => ({ ...f, at: new Date().toISOString() }))),
  done_unverified: (c) => turnState(c.message, c.actions),
};

const dir = new URL('../calibration/', import.meta.url);
const only = arg('--signal');
const brain = { recent_errors: [], blocked_attempts: 0, skipped_attempts: 0, failover_count: 0, provider_cooldown: {}, notified_sessions: [] };
console.log(`provider: ${providerOrder()[0]}\n`);

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const signal = file.replace(/\.json$/, '');
  if (only && only !== signal) continue;
  if (!STATE[signal] || !Q[signal]) { console.log(`skip ${file}: no state builder or question`); continue; }
  // Labeled candidates harvested from public data (calibration/candidates/<signal>.jsonl) join the set; unlabeled ones are skipped.
  let cases = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  try {
    const extra = readFileSync(new URL(`candidates/${signal}.jsonl`, dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const labeled = extra.filter((c) => typeof c.expect === 'boolean');
    if (labeled.length) console.log(`(+${labeled.length} labeled candidates from calibration/candidates/${signal}.jsonl; ${extra.length - labeled.length} still unlabeled)`);
    cases = [...cases, ...labeled];
  } catch { /* no candidates file */ }
  const limit = DEFAULT_CONFIG.thresholds[signal];
  const rows = await pool(cases, 3, async (c) => {
    const r = await evaluate({ state: STATE[signal](c), questions: { [signal]: Q[signal] } }, { brain, lang: 'en', timeoutMs: 15000, notices: new Set() });
    const a = r.ok ? r.answers[signal] : undefined;
    const score = a?.type === 'noul' ? a.noul : a?.type === 'score' ? a.score : NaN;
    return { id: c.id, set: c.set, expect: c.expect, score, flagged: score > limit };
  });

  console.log(`== ${signal}  (threshold > ${limit}, ${cases.length} cases)`);
  console.table(rows.map((r) => ({ ...r, ok: Number.isNaN(r.score) ? 'ERROR' : r.flagged === r.expect ? '' : r.expect ? 'MISSED' : 'FALSE BLOCK' })));
  for (const set of ['train', 'holdout', 'all']) {
    const rs = rows.filter((r) => set === 'all' || r.set === set);
    if (!rs.length || (set !== 'all' && rs.length === rows.length)) continue;
    const pos = rs.filter((r) => r.expect), neg = rs.filter((r) => !r.expect);
    const minPos = Math.min(...pos.map((r) => r.score)), maxNeg = Math.max(...neg.map((r) => r.score));
    const caught = pos.filter((r) => r.flagged).length, falseBlocks = neg.filter((r) => r.flagged).length;
    const sep = minPos > maxNeg ? `separable; any threshold in (${maxNeg}, ${minPos}) is perfect` : `overlap: lowest should-flag ${minPos}, highest should-pass ${maxNeg}`;
    console.log(`  ${set.padEnd(7)} caught ${caught}/${pos.length}  false blocks ${falseBlocks}/${neg.length}  ${sep}`);
  }
  console.log();
}
