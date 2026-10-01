import { createInterface } from 'node:readline/promises';
import { agentNames, agents, type AgentName } from './agents.js';
import { probeProvider, providers } from './api.js';
import { credentialsPath, loadCredentials, saveCredentials, type Credentials } from './brain.js';
import { t, type Lang } from './i18n.js';

export type Ask = (question: string, hidden?: boolean) => Promise<string>;

/** Terminal prompt; hidden input echoes nothing (for keys). */
export function terminalAsk(): { ask: Ask; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const anyRl = rl as any;
  const write = anyRl._writeToOutput.bind(rl);
  let muted = false;
  anyRl._writeToOutput = (s: string) => { if (!muted) write(s); };
  const ask: Ask = async (q, hidden = false) => {
    if (!hidden) return (await rl.question(q)).trim();
    process.stdout.write(q);
    muted = true;
    try { return (await rl.question('')).trim(); } finally { muted = false; process.stdout.write('\n'); }
  };
  return { ask, close: () => rl.close() };
}

const yes = (ans: string, def: boolean) => (ans ? /^y/i.test(ans) : def);

/**
 * Interactive setup: pick agents (detected ones default to yes), then enter and verify keys.
 * Keys already present in env are kept as-is unless forceKeys.
 */
export async function wizard(ask: Ask, lang: Lang, detected: AgentName[], log: (s: string) => void, forceKeys = false): Promise<AgentName[]> {
  log(t(lang, 'wiz_agents'));
  const chosen: AgentName[] = [];
  for (const name of agentNames) {
    const def = detected.includes(name);
    const ans = await ask(t(lang, 'wiz_agent_q', { label: agents[name].label, hint: def ? 'Y/n' : 'y/N', found: def ? t(lang, 'wiz_found') : '' }));
    if (yes(ans, def)) chosen.push(name);
  }

  const env = process.env;
  const hasKey = !!(env.OPENROUTER_API_KEY || (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID));
  if (hasKey && !forceKeys) {
    log(t(lang, 'wiz_keys_present'));
    return chosen;
  }

  log(t(lang, 'wiz_keys', { path: credentialsPath() }));
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

  const or = await ask(t(lang, 'wiz_or_key'), true);
  if (or) await tryKey('openrouter', { OPENROUTER_API_KEY: or });
  const acc = await ask(t(lang, 'wiz_cf_account'));
  if (acc) {
    const tok = await ask(t(lang, 'wiz_cf_token'), true);
    if (tok) await tryKey('cloudflare', { CLOUDFLARE_ACCOUNT_ID: acc, CLOUDFLARE_API_TOKEN: tok });
  }
  if (Object.keys(creds).length) log(t(lang, 'wiz_saved', { path: saveCredentials(creds) }));
  else log(t(lang, 'wiz_no_keys'));
  return chosen;
}
