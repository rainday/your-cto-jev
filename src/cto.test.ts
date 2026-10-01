import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluate } from './api.js';
import { loadBrain, saveBrain } from './brain.js';
import { chunkDiff, estimateTokens, filterDiff } from './diff.js';
import { agentPost, agentPre, gitCommit } from './hooks.js';
import { agents } from './agents.js';
import { applyCredentials, credentialsPath, saveCredentials } from './brain.js';
import { wizard } from './wizard.js';
const claudePre = (i: any, e: any) => agentPre(agents.claude, agents.claude.parsePre(i), e);
const claudePost = (i: any, e: any) => agentPost(agents.claude.parsePost(i), e);
import { detectLang } from './i18n.js';
import { maskDiff, maskSensitiveState } from './masker.js';
import { setup } from './setup.js';

const loadBrainCd = (b: any) => b.provider_cooldown.cloudflare;
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

test('credentials: file fills missing env, env wins; wizard verifies and saves keys', async () => {
  const saved = process.env.APPDATA;
  process.env.APPDATA = tmp();
  setKeys(false);
  saveCredentials({ OPENROUTER_API_KEY: 'from-file' });
  process.env.CLOUDFLARE_API_TOKEN = 'from-env';
  saveCredentials({ OPENROUTER_API_KEY: 'from-file', CLOUDFLARE_API_TOKEN: 'file-token' });
  applyCredentials();
  assert.equal(process.env.OPENROUTER_API_KEY, 'from-file');
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, 'from-env');

  setKeys(false);
  saveCredentials({});
  globalThis.fetch = (async () => new Response(JSON.stringify(answers({ probe: noul(0.9) })))) as any;
  const answersQ = ['', '', 'y', 'n', 'or-key', ''];
  const asked: string[] = [];
  const ask = async (q: string) => { asked.push(q); return answersQ.shift() ?? ''; };
  const chosen = await wizard(ask, 'en', ['cursor'], () => {});
  assert.deepEqual(chosen, ['cursor', 'gemini']); // claude: Enter on undetected -> no; cursor detected default; gemini y
  assert.equal(JSON.parse(readFileSync(credentialsPath(), 'utf8')).OPENROUTER_API_KEY, 'or-key');
  // keys already present -> no key prompts
  const n = asked.length;
  await wizard(async () => '', 'en', [], () => {});
  assert.equal(asked.length, n);
  setKeys(false);
  if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
});

test('review fixes: save failure keeps the block, pinned diff format, full .env masking, stale errors, chunk headers, bad shape', async () => {
  const { DIFF_CMD } = await import('./setup.js');
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
  // Call git directly: no sh on PATH in PowerShell/cmd. DIFF_CMD has no quoting, so a space split is exact.
  const [bin, ...diffArgs] = DIFF_CMD.split(' ');
  const diff = execFileSync(bin, diffArgs, { cwd: repo, encoding: 'utf8' });
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
