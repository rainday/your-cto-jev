import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { evaluate, providerOrder } from './api.js';
import { loadBrain, saveBrain } from './brain.js';
import { chunkDiff, estimateTokens, filterDiff } from './diff.js';
import { agentPost, agentPre, gitCommit } from './hooks.js';
import { agents } from './agents.js';
import { applyCredentials, credentialsPath, loadCredentials, loadPrefs, saveCredentials, savePrefs } from './brain.js';
import { displayWidth, setupUI } from './setupui.js';
import { PassThrough, Writable } from 'node:stream';
const claudePre = (i: any, e: any) => agentPre(agents.claude, agents.claude.parsePre(i), e);
const claudePost = (i: any, e: any) => agentPost(agents.claude.parsePost(i), e);
import { detectLang } from './i18n.js';
import { maskDiff, maskSensitiveState } from './masker.js';
import { setSprintGoal, setup, wiredAgents } from './setup.js';

const loadBrainCd = (b: any) => b.provider_cooldown.cloudflare;
process.env.CTO_NO_UPDATE_CHECK = '1'; // tests never hit the registry or write the user's cache
process.env.APPDATA = mkdtempSync(join(tmpdir(), 'cto-home-')); // never read or write the user's real keys and prefs
const tmp = () => mkdtempSync(join(tmpdir(), 'cto-'));

test('masker covers every pattern from spec section 5', () => {
  const cases: [string, string][] = [
    ['key sk_live_' + 'a'.repeat(24), '[REDACTED: STRIPE_KEY]'],
    ['key sk-proj-' + 'b'.repeat(30), '[REDACTED: OPENAI_KEY]'],
    ['AKIA' + 'C'.repeat(16), '[REDACTED: AWS_ACCESS_KEY]'],
    ['ghp_' + 'd'.repeat(36), '[REDACTED: GITHUB_TOKEN]'],
    ['npm_' + 'e'.repeat(36), '[REDACTED: NPM_TOKEN]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[REDACTED: PRIVATE_KEY_BLOCK]'],
    ['DB_PASSWORD=hunter2', 'DB_PASSWORD=[REDACTED: SENSITIVE_VALUE]'],
  ];
  for (const [raw, want] of cases) {
    const got = maskSensitiveState(raw);
    assert.ok(got.includes(want), `${raw} -> ${got}`);
  }
  // already-masked values are not masked twice
  assert.equal(maskSensitiveState('STRIPE_KEY=sk_live_' + 'a'.repeat(24)), 'STRIPE_KEY=[REDACTED: STRIPE_KEY]');
});

test('.env files are masked whole, other files only by pattern', () => {
  const diff = [
    'diff --git a/.env b/.env', '+++ b/.env', '+DATABASE_URL=postgres://u:p@h/db', '+EMPTY=', '+export FOO = bar baz',
    'diff --git a/.env.local b/.env.local', '+++ b/.env.local', '+WHATEVER=xyz',
    'diff --git a/src/a.ts b/src/a.ts', '+++ b/src/a.ts', '+const url = "postgres://u:p@h/db"',
  ].join('\n');
  const m = maskDiff(diff);
  assert.ok(m.includes('+DATABASE_URL=[REDACTED: ENV_VALUE]'));
  assert.ok(m.includes('+EMPTY='));
  assert.ok(m.includes('+export FOO = [REDACTED: ENV_VALUE]'));
  assert.ok(m.includes('+WHATEVER=[REDACTED: ENV_VALUE]'));
  assert.ok(m.includes('postgres://u:p@h/db"'));
});

test('diff filter drops locks, min, map, binaries; chunking keeps every line', () => {
  const sec = (p: string, body: string) => `diff --git a/${p} b/${p}\n${body}\n`;
  const diff = sec('package-lock.json', '+x') + sec('a.min.js', '+x') + sec('a.js.map', '+x') +
    sec('img.png', 'Binary files a/img.png and b/img.png differ') + sec('src/a.ts', '+ok');
  const files = filterDiff(diff);
  assert.equal(files.length, 1);
  assert.ok(files[0].includes('src/a.ts'));
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('abcdefgh'), 2);
  const big = sec('big.ts', Array.from({ length: 400 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n'));
  const chunks = chunkDiff([sec('s.ts', '+s'), big], 1000);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => estimateTokens(c) <= 1000 + 20));
  assert.ok(chunks.join('').includes('+line 399'));
});

test('language detection order', () => {
  assert.equal(detectLang({ CTO_LANG: 'en', LANG: 'zh_TW.UTF-8' }), 'en');
  assert.equal(detectLang({ LC_ALL: 'zh_CN.UTF-8' }), 'zh-TW');
  assert.equal(detectLang({ LANG: 'en_US.UTF-8' }), 'en');
});

// ---------- fetch mock ----------
type Reply = { status: number; body: unknown } | 'timeout';
function mockFetch(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const name = String(url).includes('cloudflare') ? 'cloudflare' : 'openrouter';
    calls.push(name);
    const r = replies[name].shift()!;
    if (r === 'timeout') throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    const body = JSON.parse(init.body);
    if (name === 'cloudflare') assert.equal(body.input.session_id, undefined, 'Cloudflare 400s on session_id');
    else assert.equal(body.model, 'typesafe/jev-1.13');
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as any;
  return calls;
}
const answers = (a: Record<string, unknown>) => ({ model: 'jev', answers: a, usage: { input_tokens: 1, output_tokens: 1 } });
const noul = (v: number) => ({ type: 'noul', noul: v });

function setKeys(on = true) {
  for (const k of ['CTO_PROVIDER', 'CTO_FAILOVER']) delete process.env[k];
  if (on) Object.assign(process.env, { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', OPENROUTER_API_KEY: 'k' });
  else for (const k of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY']) delete process.env[k];
}

test('failover: 402 cools 1h and switches; recovery switches back; 400 does not fail over', async () => {
  setKeys();
  savePrefs({ provider_order: ['cloudflare', 'openrouter'] }); // this test is about failover from a primary to a backup
  const root = tmp();
  const brain = loadBrain(root);
  let now = 1_000_000;
  const ctx = (notices = new Set<string>()) => ({ brain, lang: 'en' as const, timeoutMs: 100, notices, now: () => now });
  const req = { state: 'ls', session_id: 's', questions: { destructive_command: { type: 'noul' as const, instructions: 'x' } } };

  let calls = mockFetch({ cloudflare: [{ status: 402, body: { errors: [{ message: 'no credit' }] } }], openrouter: [{ status: 200, body: answers({ destructive_command: noul(0.1) }) }] });
  let n = new Set<string>();
  let r = await evaluate(req, ctx(n));
  assert.ok(r.ok && r.provider === 'openrouter');
  assert.deepEqual(calls, ['cloudflare', 'openrouter']);
  assert.equal(brain.provider_cooldown.cloudflare.until, now + 3_600_000);
  assert.match([...n][0], /Cloudflare out of credits \(402\), using OpenRouter for the next 1 hour/);

  // during cooldown: cloudflare skipped silently
  calls = mockFetch({ cloudflare: [], openrouter: [{ status: 200, body: answers({}) }] });
  n = new Set();
  r = await evaluate(req, ctx(n));
  assert.deepEqual(calls, ['openrouter']);
  assert.equal(n.size, 0);

  // after cooldown: cloudflare retried, recovered notice, entry cleared (Cloudflare envelope tolerated)
  now += 3_600_001;
  calls = mockFetch({ cloudflare: [{ status: 200, body: { success: true, result: answers({}) } }], openrouter: [] });
  n = new Set();
  r = await evaluate(req, ctx(n));
  assert.ok(r.ok && r.provider === 'cloudflare');
  assert.match([...n][0], /Cloudflare recovered/);
  assert.equal(brain.provider_cooldown.cloudflare, undefined);

  // timeout cools 5m; both down -> fail-open notice
  calls = mockFetch({ cloudflare: ['timeout'], openrouter: [{ status: 503, body: {} }] });
  n = new Set();
  r = await evaluate(req, ctx(n));
  assert.ok(!r.ok && r.reason === 'all_failed');
  assert.equal(loadBrainCd(brain).until, now + 300_000);
  assert.match([...n].join(), /No provider available/);

  // 400: stop, no failover
  now += 300_001;
  calls = mockFetch({ cloudflare: [{ status: 400, body: { errors: [{ message: 'Required value missing: questions' }] } }], openrouter: [] });
  r = await evaluate(req, ctx());
  assert.ok(!r.ok && r.reason === 'bad_request');
  assert.deepEqual(calls, ['cloudflare']);

  // CTO_FAILOVER=0: primary only
  process.env.CTO_FAILOVER = '0';
  calls = mockFetch({ cloudflare: [{ status: 500, body: {} }], openrouter: [] });
  r = await evaluate(req, ctx());
  assert.deepEqual(calls, ['cloudflare']);
  setKeys(false);
  assert.deepEqual(await evaluate(req, ctx()), { ok: false, reason: 'no_keys' });
  savePrefs({});
});

test('git-commit: leak blocks with exit 1, soft signals warn with exit 0, clean is silent', async () => {
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  const root = tmp();
  writeFileSync(join(root, '.cto.json'), JSON.stringify({ sprint_goal: 'ship billing' }));
  const diff = 'diff --git a/a.ts b/a.ts\n+++ b/a.ts\n+const k = "sk_live_' + 'a'.repeat(24) + '"\n';
  let sent: any;
  globalThis.fetch = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(answers({ credential_leak: noul(0.9), code_complexity: { type: 'score', score: 3.2 }, architecture_violation: noul(0.1) })));
  }) as any;
  let out = await gitCommit(diff, { root, lang: 'en' });
  assert.equal(out.code, 1);
  assert.ok(!JSON.stringify(sent).includes('sk_live_'), 'secret must be masked before sending');
  assert.ok(sent.questions.architecture_violation, 'sprint_goal set -> architecture question sent');
  assert.match(out.stderr.join('\n'), /BLOCKED/);
  assert.match(out.stderr.join('\n'), /Over-engineered/);
  assert.equal(loadBrain(root).blocked_attempts, 1);

  globalThis.fetch = (async () => new Response(JSON.stringify(answers({ credential_leak: noul(0.1), code_complexity: { type: 'score', score: 0.5 } })))) as any;
  out = await gitCommit(diff, { root, lang: 'en' });
  assert.deepEqual(out, { code: 0, stderr: [] });
  assert.deepEqual(await gitCommit('', { root, lang: 'en' }), { code: 0, stderr: [] });
  setKeys(false);
});

test('claude-pre/post: exit 2 on destructive, loop question only with recent errors, session notice once', async () => {
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  const root = tmp();
  let sent: any;
  let reply = answers({ destructive_command: noul(0.95) });
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(reply)); }) as any;

  const input = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } };
  let out = await claudePre(input, { root, lang: 'en' });
  assert.equal(out.code, 2);
  assert.match(out.stderr.join('\n'), /irreversibly destructive/);
  assert.equal(sent.session_id, 's1');
  assert.equal(sent.questions.infinite_loop, undefined);

  // post: no error field -> no record; interrupt -> no record
  claudePost({ tool_input: { command: 'x' } }, { root, lang: 'en' });
  claudePost({ tool_input: { command: 'x' }, error: 'boom', is_interrupt: true }, { root, lang: 'en' });
  assert.equal(loadBrain(root).recent_errors.length, 0);
  for (let i = 0; i < 7; i++) claudePost({ tool_input: { command: 'npm test' }, error: `Exit code 1\nTOKEN=abc ${'y'.repeat(600)}` }, { root, lang: 'en' });
  const errs = loadBrain(root).recent_errors;
  assert.equal(errs.length, 5);
  assert.ok(errs[0].error.length === 500 && errs[0].error.includes('TOKEN=[REDACTED: SENSITIVE_VALUE]'));

  reply = answers({ destructive_command: noul(0.01), infinite_loop: noul(0.2) });
  out = await claudePre({ ...input, session_id: 's2', tool_input: { command: 'npm test' } }, { root, lang: 'en' });
  assert.equal(out.code, 0);
  assert.ok(sent.questions.infinite_loop);
  assert.match(sent.state, /Recently failed commands/);
  assert.match(JSON.parse(out.stdout!).systemMessage, /Reviewing with OpenRouter/);
  out = await claudePre({ ...input, session_id: 's2', tool_input: { command: 'npm test' } }, { root, lang: 'en' });
  assert.deepEqual(out, { code: 0, stderr: [] }, 'second call in same session is silent');

  // corrupt brain rebuilds as empty
  writeFileSync(join(root, '.cto-brain.json'), '{not json');
  assert.equal(loadBrain(root).recent_errors.length, 0);
  saveBrain(root, loadBrain(root));
  assert.ok(!existsSync(join(root, '.cto-brain.json.tmp')));
  setKeys(false);
});

test('setup installs idempotently and uninstall restores exactly', () => {
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  const settingsPath = join(root, '.claude', 'settings.local.json');
  const original = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }] } };
  mkdirSync(join(root, '.claude'));
  writeFileSync(settingsPath, JSON.stringify(original, null, 2) + '\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(hook, '#!/bin/sh\nnpm run lint\n');

  assert.equal(setup(root, 'en', { agents: ['claude'] }).code, 0);
  assert.equal(setup(root, 'en', { agents: ['claude'] }).code, 0); // idempotent
  const h = readFileSync(hook, 'utf8');
  assert.equal(h.split('YOUR CTO JEV START').length, 2);
  assert.ok(h.startsWith('#!/bin/sh\nnpm run lint\n'));
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.equal(s.hooks.PostToolUseFailure[0].hooks[0].command, 'cto --hook claude-post');
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /\.cto-brain\.json/);
  assert.ok(existsSync(join(root, '.cto.json')));

  assert.equal(setup(root, 'en', { uninstall: true }).code, 0);
  assert.equal(readFileSync(hook, 'utf8'), '#!/bin/sh\nnpm run lint\n');
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), original);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n');
  assert.ok(existsSync(join(root, '.cto.json')), '.cto.json is kept');

  // fresh repo: files created by setup are removed again
  const fresh = tmp();
  execFileSync('git', ['init', '-q'], { cwd: fresh });
  setup(fresh, 'en', { agents: ['claude', 'cursor', 'gemini', 'codex'] });
  setup(fresh, 'en', { uninstall: true });
  assert.ok(!existsSync(join(fresh, '.git', 'hooks', 'pre-commit')));
  for (const d of ['.claude', '.cursor', '.gemini', '.codex']) assert.ok(!existsSync(join(fresh, d)), d);
  assert.ok(!existsSync(join(fresh, '.gitignore')));

  // early exit 0 warning
  const warn = tmp();
  execFileSync('git', ['init', '-q'], { cwd: warn });
  writeFileSync(join(warn, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
  assert.match(setup(warn, 'en', { agents: [] }).lines.join('\n'), /exit 0 before the cto block/);
});

test('setup writes each agent in its own format', () => {
  const root = tmp();
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.cursor'));
  writeFileSync(join(root, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'notify' }] } }));
  setup(root, 'en', { agents: ['cursor', 'gemini', 'codex'] });
  const read = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
  const c = read('.cursor/hooks.json');
  assert.equal(c.version, 1);
  assert.deepEqual(c.hooks.beforeShellExecution, [{ command: 'cto --hook cursor-pre' }]);
  assert.deepEqual(c.hooks.postToolUseFailure, [{ command: 'cto --hook cursor-post' }]);
  assert.equal(read('.gemini/settings.json').hooks.BeforeTool[0].matcher, 'run_shell_command');
  assert.equal(read('.codex/hooks.json').hooks.PreToolUse[0].hooks[0].command, 'cto --hook codex-pre');
  assert.ok(!existsSync(join(root, '.claude')), 'unselected agent untouched');
  setup(root, 'en', { uninstall: true });
  assert.deepEqual(read('.cursor/hooks.json'), { version: 1, hooks: { stop: [{ command: 'notify' }] } });
  assert.ok(!existsSync(join(root, '.gemini')) && !existsSync(join(root, '.codex')));
});

test('agent adapters: parse stdin and speak each blocking convention', () => {
  // Cursor: flat command, deny JSON + exit 2, notices via user_message
  assert.deepEqual(agents.cursor.parsePre({ command: 'ls', conversation_id: 'c', workspace_roots: ['/r'] }), { command: 'ls', sessionId: 'c', cwd: '/r' });
  const b = agents.cursor.block(['no']);
  assert.equal(b.code, 2);
  assert.equal(JSON.parse(b.stdout!).permission, 'deny');
  assert.equal(JSON.parse(agents.cursor.notice(['hi']).stdout!).user_message, 'hi');
  assert.equal(agents.cursor.parsePost({ tool_name: 'Read', error_message: 'x' }), null);
  assert.equal(agents.cursor.parsePost({ tool_name: 'Shell', tool_input: { command: 'npm t' }, error_message: 'boom' })?.error, 'boom');
  // Gemini: error field or non-zero Exit Code in llmContent
  assert.equal(agents.gemini.parsePost({ tool_name: 'run_shell_command', tool_response: { llmContent: 'Stdout: ok\nExit Code: 0' } }), null);
  assert.ok(agents.gemini.parsePost({ tool_name: 'run_shell_command', tool_input: { command: 'x' }, tool_response: { llmContent: 'Stderr: no\nExit Code: 1' } }));
  assert.equal(agents.gemini.parsePost({ tool_name: 'run_shell_command', tool_response: { error: 'denied' } })?.error, 'denied');
  // Codex: PostToolUse recorded only on a visible non-zero exit
  assert.equal(agents.codex.parsePost({ tool_response: { exit_code: 0, output: 'ok' } }), null);
  assert.equal(agents.codex.parsePost({ tool_input: { command: 'x' }, tool_response: { exit_code: 1, stderr: 'bad' } })?.error, 'bad');
  assert.equal(agents.codex.parsePost({ tool_response: 'some output' }), null);
});

test('credentials and prefs share a file without clobbering each other; provider order follows prefs', () => {
  const saved = process.env.APPDATA;
  process.env.APPDATA = tmp();
  setKeys(false);
  process.env.CLOUDFLARE_API_TOKEN = 'from-env';
  saveCredentials({ OPENROUTER_API_KEY: 'from-file', CLOUDFLARE_API_TOKEN: 'file-token' });
  applyCredentials();
  assert.equal(process.env.OPENROUTER_API_KEY, 'from-file');
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, 'from-env', 'env wins over the file');

  savePrefs({ provider_order: ['openrouter'], lang: 'zh-TW' });
  assert.equal(loadCredentials().OPENROUTER_API_KEY, 'from-file', 'saving prefs keeps keys');
  saveCredentials({ OPENROUTER_API_KEY: 'k2' });
  assert.deepEqual(loadPrefs(), { provider_order: ['openrouter'], lang: 'zh-TW' }, 'saving keys keeps prefs');
  assert.equal(JSON.parse(readFileSync(credentialsPath(), 'utf8')).CLOUDFLARE_API_TOKEN, undefined, 'keys are replaced exactly');

  // picked order decides, and providers left out are not used even with a key
  setKeys();
  savePrefs({ provider_order: ['openrouter'] });
  assert.deepEqual(providerOrder(), ['openrouter']);
  savePrefs({ provider_order: ['typesafe', 'openrouter'] });
  assert.deepEqual(providerOrder(), ['openrouter'], 'typesafe picked but has no key: skipped');
  process.env.TYPESAFE_API_KEY = 'ts';
  assert.deepEqual(providerOrder(), ['typesafe', 'openrouter']);
  savePrefs({});
  assert.deepEqual(providerOrder(), ['openrouter', 'typesafe', 'cloudflare'], 'no prefs: every provider with a key, fastest first');
  delete process.env.TYPESAFE_API_KEY;
  setKeys(false);
  if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
});

// ---------- interactive setup, driven by real keystrokes through clack ----------
const KEY = { up: '\x1b[A', down: '\x1b[B', space: ' ', enter: '\r', esc: '\x1b' };
async function drive<T>(run: (io: { input: PassThrough; output: Writable }) => Promise<T>, keys: string[]) {
  const input = new PassThrough();
  let out = '';
  const output = new Writable({ write(c, _e, cb) { out += c; cb(); } });
  const p = run({ input, output });
  for (const k of keys) {
    await new Promise((r) => setTimeout(r, 100)); // > clack's 50 ms escape timeout, so a lone Esc is read as Esc
    input.write(k);
  }
  return { result: await p, out };
}
const fakeProbe = async (p: string) => (p === 'cloudflare' ? { ok: false as const, status: '403', message: 'gateway auth' } : { ok: true as const });

test('setup UI, first run: walk the steps, Esc goes back, tick order is priority, failed provider can be dropped', async () => {
  const initial = { agents: ['cursor' as const], providers: [], keys: {}, goal: '' };
  const { result, out } = await drive((io) => setupUI(initial, true, 'en', { ...io, probe: fakeProbe, detected: ['cursor'], env: {} }), [
    // agents: tick Gemini (3rd)
    KEY.down, KEY.down, KEY.space, KEY.enter,
    // providers: tick Cloudflare first, then OpenRouter
    KEY.down, KEY.down, KEY.space, KEY.up, KEY.up, KEY.space, KEY.enter,
    // keys: first prompt is Cloudflare's Account ID; Esc goes back to providers
    KEY.esc,
    // providers again: untick and retick Cloudflare so OpenRouter becomes 1
    KEY.down, KEY.down, KEY.space, KEY.space, KEY.enter,
    // keys: OpenRouter key, then Cloudflare account + token, which fails verification -> drop it
    'or-key', KEY.enter, 'acc123', KEY.enter, 'cf-tok', KEY.enter, KEY.down, KEY.down, KEY.enter,
    // sprint goal, then the overview starts on "Save and finish"
    'ship billing', KEY.enter, KEY.enter,
  ]);
  assert.ok(result);
  assert.deepEqual(result.agents, ['cursor', 'gemini']);
  assert.deepEqual(result.providers, ['openrouter'], 'Cloudflare was dropped after failing');
  assert.deepEqual(result.keys, { OPENROUTER_API_KEY: 'or-key' });
  assert.equal(result.goal, 'ship billing');
  assert.match(out, /\[1\] Cloudflare/, 'tick order shown as numbers');
  assert.match(out, /\[2\] OpenRouter/);
  assert.match(out, /OpenRouter → Cloudflare/, 'second pass reordered');
  assert.match(out, /Cloudflare failed \(403\)/);
  assert.ok(!out.includes('or-key'), 'API keys are never echoed');
});

test('setup UI, later run: change one item from the overview and keep the rest; Esc on the overview quits', async () => {
  const initial = { agents: ['claude' as const], providers: ['openrouter'], keys: { OPENROUTER_API_KEY: 'or-key' }, goal: 'x' };
  const { result, out } = await drive((io) => setupUI(initial, false, 'en', { ...io, probe: fakeProbe, env: {} }), [
    // overview -> "Jev providers and API keys"
    KEY.down, KEY.enter,
    // add TypeSafe as #2
    KEY.down, KEY.space, KEY.enter,
    // OpenRouter already has a key and was picked before: not asked again; TypeSafe is new: enter one
    'ts-key', KEY.enter,
    // back on the overview: move to "Save and finish"
    KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter,
  ]);
  assert.ok(result);
  assert.deepEqual(result.agents, ['claude'], 'untouched items keep their values');
  assert.equal(result.goal, 'x');
  assert.deepEqual(result.providers, ['openrouter', 'typesafe']);
  assert.deepEqual(result.keys, { OPENROUTER_API_KEY: 'or-key', TYPESAFE_API_KEY: 'ts-key' });
  assert.ok(!/OpenRouter API key/.test(out), 'an unchanged provider is not asked again');

  const quit = await drive((io) => setupUI(initial, false, 'en', { ...io, env: {} }), [KEY.esc]);
  assert.equal(quit.result, null);
  const back = await drive((io) => setupUI(initial, true, 'en', { ...io, env: {} }), [KEY.esc]);
  assert.equal(back.result, null, 'Esc on the first step of the first run quits without saving');
});

test('review fixes: save failure keeps the block, pinned diff format, full .env masking, stale errors, chunk headers, bad shape', async () => {
  const { stagedDiff } = await import('./hooks.js');
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let sent: any;
  let reply: any = answers({ destructive_command: noul(0.95) });
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(reply)); }) as any;

  // 1. brain write fails (root does not exist): verdict must survive
  const missing = join(tmp(), 'no', 'such', 'dir');
  const out = await claudePre({ session_id: 'z', tool_input: { command: 'rm -rf ~' } }, { root: missing, lang: 'en' });
  assert.equal(out.code, 2);

  // 2. hostile git config: noprefix + forced color + mnemonic prefix
  const repo = tmp();
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q');
  for (const [k, v] of [['diff.noprefix', 'true'], ['color.diff', 'always'], ['color.ui', 'always'], ['diff.mnemonicPrefix', 'true']]) g('config', k, v);
  writeFileSync(join(repo, '.env'), 'DB_URL=postgres://u:secretpw@h/db\n');
  g('add', '.env');
  const diff = stagedDiff(repo);
  assert.ok(!/\x1b\[/.test(diff), 'no ANSI color');
  assert.match(diff, /^diff --git a\/\.env b\/\.env$/m);
  assert.ok(!maskDiff(diff).includes('secretpw'));

  // 3. removed and context lines in .env are masked too
  const envDiff = 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1,3 +1,3 @@\n DB_URL=postgres://u:ctxpw@h/db\n-OLD=removedpw\n+NEW=addedpw\n';
  const m = maskDiff(envDiff);
  for (const pw of ['ctxpw', 'removedpw', 'addedpw']) assert.ok(!m.includes(pw), pw);
  assert.ok(m.includes('--- a/.env') && m.includes(' DB_URL=[REDACTED: ENV_VALUE]') && m.includes('-OLD=[REDACTED: ENV_VALUE]'));

  // 4. failures older than the window do not trigger the loop question
  const root = tmp();
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  saveBrain(root, { ...loadBrain(root), recent_errors: [{ command: 'npm test', error: 'Exit code 1', at: old }] });
  reply = answers({ destructive_command: noul(0.01) });
  await claudePre({ session_id: 'w', tool_input: { command: 'npm test' } }, { root, lang: 'en' });
  assert.equal(sent.questions.infinite_loop, undefined);
  claudePost({ tool_input: { command: 'x' }, error: 'boom' }, { root, lang: 'en' });
  assert.equal(loadBrain(root).recent_errors.length, 1, 'stale entries pruned on write');

  // 5. every chunk of a split file carries its header
  const big = 'diff --git a/.env.example b/.env.example\n' + Array.from({ length: 300 }, (_, i) => `+K${i}=[REDACTED: ENV_VALUE] ${'x'.repeat(30)}`).join('\n') + '\n';
  const chunks = chunkDiff([big], 500);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.startsWith('diff --git a/.env.example b/.env.example\n')));

  // 6. unexpected hooks shape: refuse before writing anything
  const bad = tmp();
  execFileSync('git', ['init', '-q'], { cwd: bad });
  mkdirSync(join(bad, '.claude'));
  writeFileSync(join(bad, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: { matcher: 'Bash' } } }));
  assert.equal(setup(bad, 'en', { agents: ['claude'] }).code, 1);
  assert.ok(!existsSync(join(bad, '.git', 'hooks', 'pre-commit')), 'nothing written');
  setKeys(false);
});

test('test_tampering: asked only when tests are touched, blocks above threshold', async () => {
  const { touchesTests } = await import('./hooks.js');
  const hdr = (p: string) => `diff --git a/${p} b/${p}\n+x\n`;
  for (const p of ['src/cart.test.ts', 'tests/test_tax.py', 'app/__tests__/a.js', 'pkg/sync_test.go', 'src/__snapshots__/B.test.tsx.snap',
    'jest.config.js', 'vitest.config.ts', 'conftest.py', 'package.json', 'test/date.spec.js', 'e2e/login.spec.ts']) {
    assert.ok(touchesTests(hdr(p)), p);
  }
  for (const p of ['src/cart.ts', 'README.md', 'src/latest.ts', 'docs/testing.md', 'src/contest.py']) assert.ok(!touchesTests(hdr(p)), p);

  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  const root = tmp();
  let sent: any;
  let reply: any = answers({ credential_leak: noul(0.01), test_tampering: noul(0.92) });
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(reply)); }) as any;
  const weaken = 'diff --git a/src/cart.test.ts b/src/cart.test.ts\n--- a/src/cart.test.ts\n+++ b/src/cart.test.ts\n-  it(\'applies discount\', () => {\n+  it.skip(\'applies discount\', () => {\n';
  let out = await gitCommit(weaken, { root, lang: 'en' });
  assert.equal(out.code, 1);
  assert.match(out.stderr.join('\n'), /Fix the code, not the tests/);
  assert.ok(sent.questions.test_tampering);

  reply = answers({ credential_leak: noul(0.01), test_tampering: noul(0.6) });
  out = await gitCommit(weaken, { root, lang: 'en' });
  assert.equal(out.code, 0, '0.6 is below the 0.8 default');

  reply = answers({ credential_leak: noul(0.01) });
  out = await gitCommit('diff --git a/src/cart.ts b/src/cart.ts\n+const a = 1;\n', { root, lang: 'en' });
  assert.equal(sent.questions.test_tampering, undefined, 'no test files, no test question');
  assert.equal(out.code, 0);
  setKeys(false);
});

test('updates: minimal hook block, version compare, daily cached check, notice once per session', async () => {
  const { newer, checkUpdate, currentVersion } = await import('./update.js');
  assert.ok(newer('0.10.0', '0.9.9') && newer('1.0.0', '0.99.99') && !newer('0.2.0', '0.2.0') && !newer('0.1.9', '0.2.0'));

  // pre-commit block holds no logic, only the cto call
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: [] });
  const block = readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(block, /^\s+cto --hook git-commit \|\| exit 1$/m);
  assert.ok(!block.includes('git diff'));

  const saved = { APPDATA: process.env.APPDATA, off: process.env.CTO_NO_UPDATE_CHECK };
  process.env.APPDATA = tmp();
  delete process.env.CTO_NO_UPDATE_CHECK;
  let calls = 0;
  globalThis.fetch = (async (url: string) => {
    calls++;
    assert.match(String(url), /registry\.npmjs\.org\/your-cto-jev\/latest/);
    return new Response(JSON.stringify({ version: '99.0.0' }));
  }) as any;
  const now = Date.now();
  assert.equal(await checkUpdate(1000, now), '99.0.0');
  assert.equal(await checkUpdate(1000, now + 3_600_000), '99.0.0');
  assert.equal(calls, 1, 'second check within a day uses the cache');
  await checkUpdate(1000, now + 86_400_001);
  assert.equal(calls, 2, 'cache expires after a day');
  globalThis.fetch = (async () => { throw new Error('offline'); }) as any;
  assert.equal(await checkUpdate(1000, now + 3 * 86_400_000), undefined, 'offline is silent');
  assert.ok(/^\d+\.\d+\.\d+$/.test(currentVersion()));

  // shows up inside the once-per-session notice
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  globalThis.fetch = (async (url: string) => new Response(JSON.stringify(
    String(url).includes('registry.npmjs.org') ? { version: '99.0.0' } : answers({ destructive_command: noul(0.01) }),
  ))) as any;
  const root = tmp();
  writeFileSync(join(dirname(credentialsPath()), 'update-check.json'), '{}');
  const out = await claudePre({ session_id: 'u1', tool_input: { command: 'ls' } }, { root, lang: 'en' });
  assert.match(JSON.parse(out.stdout!).systemMessage, /Version 99\.0\.0 is available/);
  const again = await claudePre({ session_id: 'u1', tool_input: { command: 'ls' } }, { root, lang: 'en' });
  assert.equal(again.stdout, undefined, 'not repeated in the same session');
  setKeys(false);
  process.env.APPDATA = saved.APPDATA;
  process.env.CTO_NO_UPDATE_CHECK = saved.off ?? '1';
});

test('Cloudflare double-wrapped response parses; doctor reports working vs broken setups', async () => {
  // shape verified against the live API on 2026-10-02
  setKeys();
  process.env.CTO_PROVIDER = 'cloudflare';
  const wrapped = { result: { state: 'Completed', result: answers({ destructive_command: noul(0.87) }) }, success: true, errors: [], messages: [] };
  globalThis.fetch = (async () => new Response(JSON.stringify(wrapped))) as any;
  const r = await evaluate({ state: 'rm -rf ~', questions: {} }, { brain: loadBrain(tmp()), lang: 'en', timeoutMs: 1000, notices: new Set() });
  assert.ok(r.ok && (r.answers.destructive_command as any).noul === 0.87);
  delete process.env.CTO_PROVIDER;

  const { doctor } = await import('./doctor.js');
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['claude'] });

  // Cloudflare works, OpenRouter rejects the key
  globalThis.fetch = (async (url: string) => String(url).includes('cloudflare')
    ? new Response(JSON.stringify(wrapped))
    : new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as any;
  let d = await doctor(repo, 'en');
  let text = d.lines.join('\n');
  assert.match(text, /OK Cloudflare \(environment\): working/);
  assert.match(text, /!! OpenRouter .*failed \(401\)/);
  assert.match(text, /Key invalid or revoked/);
  assert.match(text, /OK git pre-commit installed/);
  assert.match(text, /Agents wired up: Claude Code/);
  assert.equal(d.code, 1, 'a broken provider is reported as needing attention');

  // nothing configured anywhere
  setKeys(false);
  d = await doctor(tmp(), 'en');
  text = d.lines.join('\n');
  assert.match(text, /No working provider/);
  assert.match(text, /Not inside a git repo/);
  assert.equal(d.code, 1);
});

test('setup UI: a digit moves a provider to that position; reorder alone asks nothing; Change API keys rotates them', async () => {
  const okProbe = async () => ({ ok: true as const });
  const initial = { agents: ['claude' as const], providers: ['openrouter', 'cloudflare'], keys: { OPENROUTER_API_KEY: 'or-key', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'cf-tok' }, goal: '' };
  const reorder = await drive((io) => setupUI(initial, false, 'en', { ...io, probe: okProbe, env: {} }), [
    KEY.down, KEY.enter, // overview -> providers
    KEY.down, KEY.down, '1', KEY.enter, // cursor to Cloudflare, press 1
    KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter, // straight back on the overview -> save
  ]);
  assert.deepEqual(reorder.result?.providers, ['cloudflare', 'openrouter']);
  assert.ok(!/Keep the current value|OpenRouter API key|Cloudflare Account ID/.test(reorder.out.split('Cloudflare → OpenRouter')[1] ?? ''), 'no key prompts after a pure reorder');

  const pick = await drive((io) => setupUI({ ...initial, providers: ['openrouter'] }, false, 'en', { ...io, probe: okProbe, env: {} }), [
    KEY.down, KEY.enter,
    KEY.down, '1', KEY.enter, // TypeSafe was not ticked: pressing 1 ticks it and puts it first
    'ts-key', KEY.enter,
    KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter,
  ]);
  assert.deepEqual(pick.result?.providers, ['typesafe', 'openrouter']);

  const rotate = await drive((io) => setupUI({ ...initial, providers: ['openrouter'] }, false, 'en', { ...io, probe: okProbe, env: {} }), [
    KEY.down, KEY.down, KEY.enter, // overview -> Change API keys
    KEY.down, KEY.enter, 'or-new', KEY.enter, // "Enter a new one"
    KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter,
  ]);
  assert.equal(rotate.result?.keys.OPENROUTER_API_KEY, 'or-new');
  assert.ok(!rotate.out.includes('or-new'), 'new key is not echoed');
});

test('displayWidth counts CJK and full-width characters as two columns', () => {
  assert.equal(displayWidth('Sprint goal'), 11);
  assert.equal(displayWidth('語言'), 4);
  assert.equal(displayWidth('Jev providers 與 API key'), 24);
  assert.equal(displayWidth('（）'), 4);
});

test('done check: parses the current turn from the transcript, gates on code edits, blocks once, never loops', async () => {
  const { turnActions, turnState } = await import('./turn.js');
  const { agentStop } = await import('./hooks.js');
  const dir = tmp();
  const L = (o: unknown) => JSON.stringify(o);
  const human = (text: string) => L({ type: 'user', message: { role: 'user', content: text } });
  const use = (id: string, name: string, input: unknown) => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: string, is_error = false) => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
  const transcript = (lines: string[]) => { const p = join(dir, `t${Math.random()}.jsonl`); writeFileSync(p, lines.join('\n') + '\n'); return p; };

  const p1 = transcript([
    human('earlier request'), use('a0', 'Edit', { file_path: join(dir, 'old.ts') }), // previous turn: ignored
    human('fix the discount bug'),
    use('a1', 'Bash', { command: 'npm test' }), result('a1', 'Tests: 48 passed'),
    use('a2', 'Edit', { file_path: join(dir, 'src', 'cart.ts') }), result('a2', 'ok'),
    use('a3', 'Bash', { command: 'npm run lint' }), result('a3', 'Exit code 1\n2 problems', true),
    use('a4', 'Bash', { command: 'sleep 999' }), // no result yet: ignored
  ]);
  const acts = turnActions(p1, dir);
  assert.deepEqual(acts.map((a) => (a.kind === 'edit' ? `edit ${a.file}` : `run ${a.command} ${a.ok}`)), [
    'run npm test true', `edit ${join('src', 'cart.ts')}`, 'run npm run lint false',
  ]);
  const state = turnState('Done, tests pass. key sk_live_' + 'a'.repeat(24), acts);
  assert.match(state, /Fact: Commands that ran after the last code edit: npm run lint/);
  assert.match(state, /-> FAILED/);
  assert.ok(!state.includes('sk_live_'), 'state is masked');

  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let calls = 0;
  let reply = answers({ done_unverified: noul(0.9) });
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify(reply)); }) as any;
  const root = tmp();
  const stop = (transcriptPath: string, stopHookActive = false) =>
    agentStop(agents.claude, { transcriptPath, cwd: dir, lastMessage: 'Done!', stopHookActive, sessionId: 's' }, { root, lang: 'en' });

  let out = await stop(p1);
  assert.equal(out.code, 2);
  assert.match(out.stderr.join('\n'), /Done, you say\? Show me/);
  assert.equal(calls, 1);

  assert.deepEqual(await stop(p1, true), { code: 0, stderr: [] }, 'never blocks twice in a row');
  const docsOnly = transcript([human('update docs'), use('d1', 'Edit', { file_path: join(dir, 'README.md') }), use('d2', 'Write', { file_path: join(dir, '.github', 'workflows', 'ci.yml') })]);
  assert.deepEqual(await stop(docsOnly), { code: 0, stderr: [] }, 'docs/config-only turns are not checked');
  const qa = transcript([human('where is the retry logic?'), use('q1', 'Bash', { command: 'rg retry' }), result('q1', 'src/queue.ts:12')]);
  assert.deepEqual(await stop(qa), { code: 0, stderr: [] }, 'turns without edits are not checked');
  assert.equal(calls, 1, 'gated turns never call Jev');

  reply = answers({ done_unverified: noul(0.3) });
  out = await stop(p1);
  assert.equal(out.code, 0, '0.3 is below the 0.6 default');
  setKeys(false);

  // setup wires the Stop hook for Claude Code and removes it again
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['claude'] });
  const settingsPath = join(repo, '.claude', 'settings.local.json');
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'cto --hook claude-stop' }] }]);
  setup(repo, 'en', { uninstall: true });
  assert.ok(!existsSync(settingsPath));
});

test('edits mark failures instead of erasing them; the loop fact counts repeats and edits', async () => {
  const { agentEdit, loopFact } = await import('./hooks.js');
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let sent: any;
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(answers({ destructive_command: noul(0.01), infinite_loop: noul(0.1) }))); }) as any;
  const root = tmp();
  const env = { root, lang: 'en' as const };
  const fail = () => claudePost({ tool_input: { command: 'npm test' }, error: 'Exit code 1\nexpected 180, got 18000' }, env);

  fail();
  await claudePre({ session_id: 'L', tool_input: { command: 'npm test' } }, env);
  assert.match(sent.state, /failed 1 time\(s\) recently; its latest error has now appeared 1 time\(s\) in a row; the agent has not edited/);

  agentEdit(['README.md'], env);
  assert.ok(!loadBrain(root).recent_errors[0].edited_after, 'docs edits do not count as a fix attempt');
  agentEdit([join('src', 'cart.ts')], env);
  assert.equal(loadBrain(root).recent_errors.length, 1, 'failures are kept');
  await claudePre({ session_id: 'L', tool_input: { command: 'npm test' } }, env);
  assert.match(sent.state, /\(the agent edited code after this failure\)/);
  assert.match(sent.state, /the agent has edited code since the most recent failure/);

  // same error again after the edit, edit again: the streak shows it is a repeated failed fix
  fail();
  agentEdit([join('src', 'cart.ts')], env);
  await claudePre({ session_id: 'L', tool_input: { command: 'npm test' } }, env);
  assert.match(sent.state, /failed 2 time\(s\) recently; its latest error has now appeared 2 time\(s\) in a row; the agent has edited code/);
  assert.match(loopFact('npm run build', loadBrain(root).recent_errors), /none of the recent failures were this exact command/);
  setKeys(false);
});

test('review fixes 2: empty provider pick means none; setup is additive unless exact; safe .cto.json handling', async () => {
  // empty pick = use no provider (not "all")
  setKeys();
  savePrefs({ provider_order: [] });
  assert.deepEqual(providerOrder(), []);
  savePrefs({});
  setKeys(false);

  // --yes / flags only add: committed hooks of agents this machine lacks stay put
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['claude', 'cursor'] });
  setup(repo, 'en', { agents: ['claude'] });
  assert.match(readFileSync(join(repo, '.cursor', 'hooks.json'), 'utf8'), /cto --hook cursor-pre/, 'additive by default');
  setup(repo, 'en', { agents: ['claude'], exact: true });
  assert.ok(!existsSync(join(repo, '.cursor', 'hooks.json')), 'exact mode removes unpicked agents');

  // a broken config of an agent nobody asked about cannot block the install
  mkdirSync(join(repo, '.gemini'));
  writeFileSync(join(repo, '.gemini', 'settings.json'), '{ broken');
  assert.equal(setup(repo, 'en', { agents: ['claude'] }).code, 0);
  assert.equal(setup(repo, 'en', { agents: ['claude'], exact: true }).code, 0, 'gemini has no cto hooks, so it is not read');

  // new .cto.json leaves thresholds to the package defaults; a broken one is never overwritten
  const fresh = tmp();
  execFileSync('git', ['init', '-q'], { cwd: fresh });
  setup(fresh, 'en', { agents: [] });
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, '.cto.json'), 'utf8')), { sprint_goal: '', thresholds: {} });
  assert.ok(setSprintGoal(fresh, 'ship billing'));
  assert.equal(JSON.parse(readFileSync(join(fresh, '.cto.json'), 'utf8')).sprint_goal, 'ship billing');
  writeFileSync(join(fresh, '.cto.json'), '{ "thresholds": { "credential_leak": 0.3 }, }');
  assert.equal(setSprintGoal(fresh, 'x'), false);
  assert.equal(readFileSync(join(fresh, '.cto.json'), 'utf8'), '{ "thresholds": { "credential_leak": 0.3 }, }', 'left untouched');
});

test('review fixes 3: meta transcript entries do not start a new turn; the fact sees edits beyond the shown log', async () => {
  const { turnActions, turnState } = await import('./turn.js');
  const dir = tmp();
  const L = (o: unknown) => JSON.stringify(o);
  const p = join(dir, 't.jsonl');
  writeFileSync(p, [
    L({ type: 'user', message: { role: 'user', content: 'fix it' } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(dir, 'src', 'a.ts') } }] } }),
    L({ type: 'user', isMeta: true, message: { role: 'user', content: '[Image: original 800x600]' } }),
  ].join('\n'));
  assert.equal(turnActions(p, dir).length, 1, 'the edit before the meta entry still belongs to this turn');

  const many = [{ kind: 'edit' as const, file: 'src/a.ts' }, ...Array.from({ length: 45 }, (_, i) => ({ kind: 'edit' as const, file: `docs/n${i}.md` }))];
  assert.match(turnState('Done', many), /Fact: No command ran after the last code edit/, 'code edit 46 actions back still counts');
});

test('a loop is blocked once per episode, so the agent can still verify its next fix', async () => {
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let asked = 0;
  globalThis.fetch = (async (_u: string, init: any) => {
    if (JSON.parse(init.body).questions.infinite_loop) asked++;
    return new Response(JSON.stringify(answers({ destructive_command: noul(0.01), infinite_loop: noul(0.95) })));
  }) as any;
  const root = tmp();
  const env = { root, lang: 'en' as const };
  const fail = () => claudePost({ tool_input: { command: 'npm test' }, error: 'Exit code 1\nsame' }, env);
  const pre = () => claudePre({ session_id: 'E', tool_input: { command: 'npm test' } }, env);
  fail(); fail();
  assert.equal((await pre()).code, 2, 'loop blocked');
  assert.equal((await pre()).code, 0, 'next attempt after the warning may run');
  assert.equal(asked, 1, 'no loop question while the latest failure is already warned');
  fail();
  assert.equal((await pre()).code, 2, 'a new failure can be blocked again');
  setKeys(false);
});

test('guidance: rules block in always-loaded files, one skill, only cto content touched, staleness detected', async () => {
  const { RULES_BLOCK, SKILL_TEXT, staleGuidance } = await import('./skill.js');
  const { missingHooks } = await import('./setup.js');
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const read = (p: string) => readFileSync(join(repo, p), 'utf8');
  writeFileSync(join(repo, 'CLAUDE.md'), '# My project\n\nUse pnpm.\n');

  setup(repo, 'en', { agents: ['claude'] });
  assert.ok(read('CLAUDE.md').startsWith('# My project\n\nUse pnpm.\n'), 'user content kept');
  assert.ok(read('CLAUDE.md').includes(RULES_BLOCK), 'rules block appended');
  assert.ok(!existsSync(join(repo, 'AGENTS.md')) && !existsSync(join(repo, 'GEMINI.md')), 'only files the chosen agents read');
  assert.equal(read('.agents/skills/cto/SKILL.md'), SKILL_TEXT, 'one detailed skill');
  assert.ok(!existsSync(join(repo, '.claude', 'skills')), 'no second copy for Cursor to see twice');
  for (const s of ['credential_leak', 'test_tampering', 'done_unverified', 'infinite_loop', 'destructive_command', 'architecture_violation', 'code_complexity']) {
    assert.ok(RULES_BLOCK.includes('`' + s + '`') && SKILL_TEXT.includes('`' + s + '`'), `every check has a rule: ${s}`);
  }
  assert.match(RULES_BLOCK, /\.agents\/skills\/cto\/SKILL\.md/, 'block points every agent, including Claude Code, to the skill');

  setup(repo, 'en', { agents: ['claude'] });
  assert.equal(read('CLAUDE.md').split('YOUR CTO JEV START').length, 2, 'idempotent');

  setup(repo, 'en', { agents: ['gemini', 'cursor'] });
  assert.ok(read('GEMINI.md').includes(RULES_BLOCK) && read('AGENTS.md').includes(RULES_BLOCK));
  setup(repo, 'en', { agents: ['gemini'], exact: true });
  assert.ok(!existsSync(join(repo, 'AGENTS.md')), 'exact: block removed, file we created removed');
  assert.equal(read('CLAUDE.md'), '# My project\n\nUse pnpm.\n', 'exact: user file restored exactly');

  // staleness: edited rules or a hook phase missing from an older install
  setup(repo, 'en', { agents: ['claude'] });
  assert.deepEqual(staleGuidance(repo, ['claude']), []);
  writeFileSync(join(repo, '.agents/skills/cto/SKILL.md'), 'old text');
  assert.deepEqual(staleGuidance(repo, ['claude']), ['.agents/skills/cto/SKILL.md']);
  const settingsPath = join(repo, '.claude', 'settings.local.json');
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  delete s.hooks.PostToolUse;
  writeFileSync(settingsPath, JSON.stringify(s));
  assert.deepEqual(missingHooks(repo), ['cto --hook claude-edit']);
  // what --refresh does: re-run setup for the agents already wired, adding only
  setup(repo, 'en', { agents: wiredAgents(repo) });
  assert.deepEqual(missingHooks(repo), []);
  assert.deepEqual(staleGuidance(repo, ['claude']), []);

  setup(repo, 'en', { uninstall: true });
  assert.equal(read('CLAUDE.md'), '# My project\n\nUse pnpm.\n');
  assert.ok(!existsSync(join(repo, '.agents')) && !existsSync(join(repo, 'GEMINI.md')));
});

test('cto check: previews the commit checks on staged or working-tree changes, without touching the index', async () => {
  const { pendingDiff, runCheck } = await import('./check.js');
  const repo = tmp();
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  g('add', '.'); g('commit', '-qm', 'base');

  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'new.test.ts'), 'it.skip("x", () => {});\n');
  let p = pendingDiff(repo);
  assert.equal(p.source, 'working');
  assert.match(p.diff, /diff --git a\/a\.ts b\/a\.ts/);
  assert.match(p.diff, /new\.test\.ts/, 'untracked new files are included');
  assert.equal(g('diff', '--cached', '--name-only').trim(), '', 'index untouched');

  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let sent: any;
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(answers({ credential_leak: noul(0.02), test_tampering: noul(0.93), code_complexity: { type: 'score', score: 0.4 } }))); }) as any;
  let r = await runCheck(repo, 'en');
  const out = r.lines.join('\n');
  assert.equal(r.code, 1, 'would block');
  assert.ok(sent.questions.test_tampering, 'a test file changed, so the test check ran');
  assert.match(out, /credential_leak\s+0\.02\s+blocks above 0\.5\s+ok/);
  assert.match(out, /test_tampering\s+0\.93\s+blocks above 0\.8\s+WOULD BLOCK/);
  assert.match(out, /architecture_violation\s+not checked: sprint_goal is empty/);
  assert.match(out, /Fix the code, not the tests/);
  assert.equal(loadBrain(repo).blocked_attempts, 0, 'a preview is not counted as a block');

  g('add', 'a.ts');
  p = pendingDiff(repo);
  assert.equal(p.source, 'staged');
  assert.ok(!p.diff.includes('new.test.ts'), 'staged changes only, like a real commit');
  globalThis.fetch = (async () => new Response(JSON.stringify(answers({ credential_leak: noul(0.02), code_complexity: { type: 'score', score: 0.4 } })))) as any;
  r = await runCheck(repo, 'en');
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /test_tampering\s+not checked: no test files changed/);
  assert.match(r.lines.join('\n'), /Good to commit/);
  setKeys(false);
});

test('doctor shows when the last answered check ran', async () => {
  const { doctor } = await import('./doctor.js');
  const { countCheck } = await import('./hooks.js');
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['claude'] });
  let text = (await doctor(repo, 'en')).lines.join('\n');
  assert.match(text, /No successful check yet/);
  const b = loadBrain(repo);
  countCheck(b, () => Date.now() - 3 * 60_000);
  countCheck(b, () => Date.now() - 3 * 60_000);
  saveBrain(repo, b);
  text = (await doctor(repo, 'en')).lines.join('\n');
  assert.match(text, /Last check: 3 min ago, 2 in total/);
});

test('doctor: a slow backup is a note, a slow primary is a problem; rules ignored by git are flagged', async () => {
  const { doctor } = await import('./doctor.js');
  const { ignoredByGit } = await import('./setup.js');
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.gitignore'), '.agents/skills/\n');
  const lines = setup(repo, 'en', { agents: ['claude'] }).lines.join('\n');
  assert.match(lines, /\.agents\/skills\/cto\/SKILL\.md is ignored by \.gitignore[\s\S]*git add -f \.agents\/skills\/cto\/SKILL\.md/, 'setup warns and shows a fix that always works');
  assert.deepEqual(ignoredByGit(repo, ['CLAUDE.md', '.agents/skills/cto/SKILL.md']), ['.agents/skills/cto/SKILL.md']);

  setKeys();
  const wrapped = (a: unknown) => ({ result: { state: 'Completed', result: a } });
  globalThis.fetch = (async (url: string) => {
    const cf = String(url).includes('cloudflare');
    if (cf) await new Promise((r) => setTimeout(r, 120));
    return new Response(JSON.stringify(cf ? wrapped(answers({ probe: noul(0.9) })) : answers({ probe: noul(0.9) })));
  }) as any;
  savePrefs({ provider_order: ['openrouter', 'cloudflare'] });
  let d = await doctor(repo, 'en', 60);
  let text = d.lines.join('\n');
  assert.match(text, /-- Cloudflare .*this backup provider took longer/);
  assert.match(text, /\.agents\/skills\/cto\/SKILL\.md is ignored by \.gitignore/);
  assert.equal(d.code, 0, 'slow backup and ignored rules do not fail doctor');

  savePrefs({ provider_order: ['cloudflare', 'openrouter'] });
  d = await doctor(repo, 'en', 60);
  text = d.lines.join('\n');
  assert.match(text, /!! Cloudflare .*slower than the 0\.06 s agent timeout/);
  assert.equal(d.code, 1, 'slow primary fails doctor');
  // the advised fix works even though the parent folder is ignored, and then doctor stops flagging it
  execFileSync('git', ['add', '-f', '.agents/skills/cto/SKILL.md'], { cwd: repo });
  text = (await doctor(repo, 'en', 60)).lines.join('\n');
  assert.ok(!/is ignored by \.gitignore/.test(text), 'tracked after git add -f: no longer flagged');
  savePrefs({});
  setKeys(false);
});

test('edit hooks for every agent: each payload yields the edited files, and setup wires them in each format', async () => {
  const { agentEdit } = await import('./hooks.js');
  assert.deepEqual(agents.claude.parseEdit!({ tool_input: { file_path: 'src/a.ts' } }), ['src/a.ts']);
  assert.deepEqual(agents.cursor.parseEdit!({ file_path: '/r/src/a.ts', edits: [] }), ['/r/src/a.ts']);
  assert.deepEqual(agents.gemini.parseEdit!({ tool_name: 'replace', tool_input: { file_path: 'src/a.ts' } }), ['src/a.ts']);
  const patch = '*** Begin Patch\n*** Update File: src/cart.ts\n@@\n-a\n+b\n*** Add File: docs/notes.md\n+hi\n*** End Patch';
  assert.deepEqual(agents.codex.parseEdit!({ tool_name: 'apply_patch', tool_input: { command: patch } }), ['src/cart.ts', 'docs/notes.md']);
  assert.equal(agents.codex.parseEdit!({ tool_input: { command: 'not a patch' } }), undefined);

  // a Codex patch touching code marks earlier failures; a docs-only patch does not
  const root = tmp();
  const env = { root, lang: 'en' as const };
  claudePost({ tool_input: { command: 'npm test' }, error: 'Exit code 1\nx' }, env);
  agentEdit(agents.codex.parseEdit!({ tool_input: { command: '*** Begin Patch\n*** Update File: README.md\n*** End Patch' } }), env);
  assert.ok(!loadBrain(root).recent_errors[0].edited_after);
  agentEdit(agents.codex.parseEdit!({ tool_input: { command: patch } }), env);
  assert.ok(loadBrain(root).recent_errors[0].edited_after);

  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['cursor', 'gemini', 'codex'] });
  const read = (p: string) => JSON.parse(readFileSync(join(repo, p), 'utf8'));
  assert.deepEqual(read('.cursor/hooks.json').hooks.afterFileEdit, [{ command: 'cto --hook cursor-edit' }]);
  assert.ok(read('.gemini/settings.json').hooks.AfterTool.some((m: any) => m.matcher === 'write_file|replace' && m.hooks[0].command === 'cto --hook gemini-edit'));
  assert.ok(read('.codex/hooks.json').hooks.PostToolUse.some((m: any) => m.matcher === 'apply_patch' && m.hooks[0].command === 'cto --hook codex-edit'));
  setup(repo, 'en', { uninstall: true });
  for (const d of ['.cursor', '.gemini', '.codex']) assert.ok(!existsSync(join(repo, d)), d);
});

test('shell edits count as edits: sed -i, redirects, tee, cp/mv/rm, formatters; not 2>&1 or /dev/null', async () => {
  const { shellWrites } = await import('./shellwrites.js');
  const cases: [string, string[]][] = [
    ['sed -i "s/a/b/" src/cart.ts', ['src/cart.ts']], ['sed -i.bak -e s/a/b/ src/x.py', ['src/x.py']],
    ['perl -pi -e s/a/b/ lib/a.pm', ['lib/a.pm']], ['echo hi > src/gen.ts', ['src/gen.ts']],
    ['cat >> README.md <<EOF', ['README.md']], ['echo x | tee src/a.ts', ['src/a.ts']],
    ['cp src/a.ts src/b.ts', ['src/b.ts']], ['mv old.ts new.ts', ['new.ts']], ['rm -f src/dead.ts', ['src/dead.ts']],
    ['npx prettier --write .', ['?']], ['npx eslint --fix src', ['?']], ['git apply fix.patch', ['?']],
    ['npm test 2>&1 | tail -5', []], ['npm test > /dev/null', []], ['ls -la', []], ['git status', []],
    ['grep -n foo src/a.ts', []], ['npm run build && npm test', []], ['cargo test 2>err.log', []],
  ];
  for (const [cmd, want] of cases) assert.deepEqual(shellWrites(cmd), want, cmd);

  // loop detection: a sed -i before the retry is a fix attempt
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let sent: any;
  globalThis.fetch = (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify(answers({ destructive_command: noul(0.01), infinite_loop: noul(0.1) }))); }) as any;
  const root = tmp();
  const env = { root, lang: 'en' as const };
  claudePost({ tool_input: { command: 'npm test' }, error: 'Exit code 1\nexpected 180' }, env);
  await claudePre({ session_id: 'S', tool_input: { command: "sed -i 's/100/1/' src/cart.ts" } }, env);
  assert.ok(loadBrain(root).recent_errors[0].edited_after, 'sed -i marks the failure');
  await claudePre({ session_id: 'S', tool_input: { command: 'npm test' } }, env);
  assert.match(sent.state, /the agent has edited code since the most recent failure/);
  setKeys(false);

  // done check: a turn that only edited through the shell is checked, and the order is right
  const { turnActions, turnState } = await import('./turn.js');
  const dir = tmp();
  const L = (o: unknown) => JSON.stringify(o);
  const p = join(dir, 't.jsonl');
  writeFileSync(p, [
    L({ type: 'user', message: { role: 'user', content: 'fix it' } }),
    L({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: { command: "sed -i 's/a/b/' src/a.ts && npm test" } }] } }),
    L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Tests: 3 passed', is_error: false }] } }),
  ].join('\n'));
  const acts = turnActions(p, dir);
  assert.deepEqual(acts.map((a) => a.kind), ['edit', 'run'], 'the write is listed before the run that contains it');
  assert.match(turnState('Done', acts), /Commands that ran after the last code edit: sed -i/);
});

test('done check for Cursor, Gemini and Codex runs on cto\'s own turn log, with each agent\'s way to keep working', async () => {
  const { agentPre, agentPost, agentEdit, agentStop, agentReply } = await import('./hooks.js');
  setKeys();
  process.env.CTO_PROVIDER = 'openrouter';
  let sent: any;
  let doneScore = 0.9;
  globalThis.fetch = (async (_u: string, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(answers({ destructive_command: noul(0.01), done_unverified: noul(doneScore) })));
  }) as any;
  const root = tmp();
  const env = { root, lang: 'en' as const };
  const cx = agents.codex;

  // Codex: patch, then stop claiming success with nothing run -> sent back to work (exit 2)
  const patch = { session_id: 'C1', cwd: root, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } };
  agentEdit(cx.parseEdit!(patch), env, cx.session(patch));
  let out = await agentStop(cx, cx.parseStop!({ session_id: 'C1', cwd: root, last_assistant_message: 'Done, all tests pass.', stop_hook_active: false }), env);
  assert.equal(out.code, 2);
  assert.match(out.stderr.join('\n'), /Done, you say\? Show me/);
  assert.match(sent.state, /edited src\/a\.ts/);
  assert.match(sent.state, /No command ran after the last code edit/);
  assert.equal(loadBrain(root).turns?.C1, undefined, 'the turn log ends with the stop');

  // Codex: patch, test fails, the failure is in the log
  agentEdit(cx.parseEdit!(patch), env, 'C2');
  await agentPre(cx, cx.parsePre({ session_id: 'C2', cwd: root, tool_input: { command: 'npm test' } }), env);
  agentPost(cx.parsePost({ session_id: 'C2', cwd: root, tool_input: { command: 'npm test' }, tool_response: { exit_code: 1, output: '2 failed' } }), env);
  doneScore = 0.95;
  await agentStop(cx, cx.parseStop!({ session_id: 'C2', cwd: root, last_assistant_message: 'Fixed.', stop_hook_active: false }), env);
  assert.match(sent.state, /ran: npm test -> FAILED/);

  // Codex: patch, test passes -> allowed
  agentEdit(cx.parseEdit!(patch), env, 'C3');
  await agentPre(cx, cx.parsePre({ session_id: 'C3', cwd: root, tool_input: { command: 'npm test' } }), env);
  doneScore = 0.1;
  out = await agentStop(cx, cx.parseStop!({ session_id: 'C3', cwd: root, last_assistant_message: 'Fixed; tests pass.', stop_hook_active: false }), env);
  assert.equal(out.code, 0);
  assert.match(sent.state, /Commands that ran after the last code edit: npm test/);

  // Cursor: final text comes from afterAgentResponse; a block is a followup_message; our own follow-up is not re-checked
  const cu = agents.cursor;
  agentEdit(cu.parseEdit!({ conversation_id: 'K1', workspace_roots: [root], file_path: join(root, 'src', 'b.ts') }), env, 'K1');
  agentReply(cu.parseReply!({ conversation_id: 'K1', workspace_roots: [root], text: 'All done, it works.' }), env);
  doneScore = 0.9;
  out = await agentStop(cu, cu.parseStop!({ conversation_id: 'K1', workspace_roots: [root], status: 'completed', loop_count: 0 }), env);
  assert.equal(out.code, 0);
  assert.match(JSON.parse(out.stdout!).followup_message, /Done, you say\?/);
  assert.match(sent.state, /All done, it works\./);
  agentEdit(['src/b.ts'], env, 'K1');
  const calls = sent;
  out = await agentStop(cu, cu.parseStop!({ conversation_id: 'K1', workspace_roots: [root], status: 'completed', loop_count: 1 }), env);
  assert.deepEqual(out, { code: 0, stderr: [] }, 'loop_count > 0: never re-check our own follow-up');
  assert.equal(sent, calls, 'no Jev call');

  // Gemini: AfterAgent with prompt_response; exit 2 retries
  const ge = agents.gemini;
  agentEdit(ge.parseEdit!({ session_id: 'G1', tool_name: 'replace', tool_input: { file_path: 'src/c.ts' } }), env, 'G1');
  out = await agentStop(ge, ge.parseStop!({ session_id: 'G1', cwd: root, prompt_response: 'Implemented and verified.', stop_hook_active: false }), env);
  assert.equal(out.code, 2);
  assert.match(sent.state, /Implemented and verified\./);
  setKeys(false);

  // setup wires every agent's stop event (and Cursor's reply event)
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  setup(repo, 'en', { agents: ['cursor', 'gemini', 'codex'] });
  const read = (p: string) => JSON.parse(readFileSync(join(repo, p), 'utf8'));
  assert.deepEqual(read('.cursor/hooks.json').hooks.stop, [{ command: 'cto --hook cursor-stop' }]);
  assert.deepEqual(read('.cursor/hooks.json').hooks.afterAgentResponse, [{ command: 'cto --hook cursor-reply' }]);
  assert.equal(read('.gemini/settings.json').hooks.AfterAgent[0].hooks[0].command, 'cto --hook gemini-stop');
  assert.equal(read('.codex/hooks.json').hooks.Stop[0].hooks[0].command, 'cto --hook codex-stop');
});
