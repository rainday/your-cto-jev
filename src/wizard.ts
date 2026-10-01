import { createInterface } from 'node:readline/promises';
import { agentNames, agents, type AgentName } from './agents.js';
import { probeProvider, providers } from './api.js';
import { credentialsPath, loadCredentials, saveCredentials, type Credentials } from './brain.js';
import { t, type Lang } from './i18n.js';

export type Ask = (question: string, hidden?: boolean) => Promise<string>;

interface RawIn extends NodeJS.EventEmitter {
  setRawMode?(mode: boolean): unknown;
  setEncoding(enc: BufferEncoding): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Read a line without echoing it (for keys). Public APIs only: raw mode + our own key handling.
 * Enter submits, Backspace deletes, Ctrl+C aborts; escape sequences such as bracketed paste markers are dropped.
 */
export function readHidden(q: string, input: RawIn = process.stdin, output: { write(s: string): unknown } = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(q);
    let buf = '';
    const finish = (err?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (err) reject(err); else resolve(buf.trim());
    };
    const onData = (chunk: string | Buffer) => {
      const s = String(chunk).replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u0003') return finish(new Error('aborted'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

/** Terminal prompts. A fresh readline per visible question, so it never fights raw-mode hidden input. */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const ask: Ask = async (q, hidden = false) => {
    if (hidden) return readHidden(q);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    try { return (await rl.question(q)).trim(); } finally { rl.close(); }
  };
  return { ask, close: () => process.stdin.pause() };
}

const yes = (ans: string, def: boolean) => (ans ? /^y/i.test(ans) : def);

/** Parse "1,3" or "1 3" into 0-based indexes; null if anything is not a number in range. */
export function parsePicks(input: string, n: number): number[] | null {
  const idx = input.split(/[\s,]+/).filter(Boolean).map((p) => Number(p) - 1);
  return idx.every((i) => Number.isInteger(i) && i >= 0 && i < n) ? [...new Set(idx)] : null;
}

const PROVIDER_OPTIONS = ['openrouter', 'cloudflare'] as const;

/**
 * Interactive setup in two announced steps. Each step shows its full checklist first, so nobody misses an option:
 * 1. Agents: detected ones pre-checked; type numbers to toggle, Enter to confirm.
 * 2. API providers: type numbers to pick, Enter to skip. Keys are asked only for picked providers, then verified.
 * Keys already present in env are kept as-is unless forceKeys.
 */
export async function wizard(ask: Ask, lang: Lang, detected: AgentName[], log: (s: string) => void, forceKeys = false): Promise<AgentName[]> {
  log(t(lang, 'wiz_intro'));

  // Step 1: agents checklist
  log(t(lang, 'wiz_step_agents'));
  const picked = new Set<AgentName>(detected);
  for (;;) {
    agentNames.forEach((name, i) => {
      const box = picked.has(name) ? '[x]' : '[ ]';
      const found = detected.includes(name) ? t(lang, 'wiz_found') : '';
      log(`  ${box} ${i + 1}. ${agents[name].label}${found}`);
    });
    const ans = await ask(t(lang, 'wiz_agents_hint'));
    if (!ans) break;
    const idx = parsePicks(ans, agentNames.length);
    if (!idx) { log(t(lang, 'wiz_invalid')); continue; }
    for (const i of idx) {
      const n = agentNames[i];
      if (picked.has(n)) picked.delete(n); else picked.add(n);
    }
  }
  const chosen = agentNames.filter((n) => picked.has(n));

  // Step 2: API providers checklist
  log(t(lang, 'wiz_step_keys'));
  const env = process.env;
  const hasKey = !!(env.OPENROUTER_API_KEY || (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID));
  if (hasKey && !forceKeys) {
    log(t(lang, 'wiz_keys_present'));
    return chosen;
  }
  log(t(lang, 'wiz_keys', { path: credentialsPath() }));
  PROVIDER_OPTIONS.forEach((p, i) => log(`  ${i + 1}. ${t(lang, 'wiz_provider_' + p)}`));
  let which: number[] | null = null;
  while (!which) {
    const ans = await ask(t(lang, 'wiz_providers_hint'));
    which = ans ? parsePicks(ans, PROVIDER_OPTIONS.length) : [];
    if (!which) log(t(lang, 'wiz_invalid'));
  }

  const creds: Credentials = { ...loadCredentials() };
  const tryKey = async (provider: string, set: Credentials) => {
    const saved = { ...env };
    Object.assign(env, set);
    log(t(lang, 'wiz_checking', { name: providers[provider].label }));
    const r = await probeProvider(provider);
    if (r.ok) {
      log(t(lang, 'wiz_ok', { name: providers[provider].label }));
      Object.assign(creds, set);
      return;
    }
    log(t(lang, 'wiz_fail', { name: providers[provider].label, status: r.status, msg: r.message ?? '' }));
    if (yes(await ask(t(lang, 'wiz_save_anyway')), false)) Object.assign(creds, set);
    else for (const k of Object.keys(set)) { if (saved[k] === undefined) delete env[k]; else env[k] = saved[k]; }
  };

  for (const i of which) {
    if (PROVIDER_OPTIONS[i] === 'openrouter') {
      const key = await ask(t(lang, 'wiz_or_key'), true);
      if (key) await tryKey('openrouter', { OPENROUTER_API_KEY: key });
    } else {
      const acc = await ask(t(lang, 'wiz_cf_account'));
      const tok = acc ? await ask(t(lang, 'wiz_cf_token'), true) : '';
      if (acc && tok) await tryKey('cloudflare', { CLOUDFLARE_ACCOUNT_ID: acc, CLOUDFLARE_API_TOKEN: tok });
    }
  }
  if (Object.keys(creds).length) log(t(lang, 'wiz_saved', { path: saveCredentials(creds) }));
  else log(t(lang, 'wiz_no_keys'));
  return chosen;
}
