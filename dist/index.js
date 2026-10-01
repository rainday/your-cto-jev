#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentNames, agents } from './agents.js';
import { applyCredentials, findRoot } from './brain.js';
import { agentPost, agentPre, gitCommit } from './hooks.js';
import { detectLang, t } from './i18n.js';
import { maskDiff, maskSensitiveState } from './masker.js';
import { detectAgents, setup } from './setup.js';
import { terminalAsk, wizard } from './wizard.js';
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    let s = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin)
        s += chunk;
    return s;
}
function emit(out) {
    if (out.stdout)
        process.stdout.write(out.stdout + '\n');
    if (out.stderr.length)
        process.stderr.write(out.stderr.join('\n') + '\n');
    process.exitCode = out.code;
}
async function runHook(name) {
    const raw = await readStdin();
    const lang = detectLang();
    const debug = (root, text) => {
        if (process.env.CTO_DEBUG === '1')
            writeFileSync(join(root, 'debug_stdin.json'), text);
    };
    if (name === 'git-commit') {
        const root = findRoot();
        debug(root, maskDiff(raw));
        return gitCommit(raw, { root, lang });
    }
    const m = /^(claude|cursor|gemini|codex)-(pre|post)$/.exec(name);
    if (!m)
        return { code: 0, stderr: [] };
    const agent = agents[m[1]];
    let input = {};
    try {
        input = JSON.parse(raw);
    }
    catch { /* fail-open below */ }
    if (m[2] === 'pre') {
        const pre = agent.parsePre(input);
        const root = findRoot(pre.cwd ?? process.cwd());
        debug(root, maskSensitiveState(raw));
        return agentPre(agent, pre, { root, lang });
    }
    const post = agent.parsePost(input);
    const root = findRoot(post?.cwd ?? input?.cwd ?? process.cwd());
    debug(root, maskSensitiveState(raw));
    return agentPost(post, { root, lang });
}
const args = process.argv.slice(2);
const lang = detectLang();
const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
applyCredentials();
if (args[0] === '--hook' && args[1]) {
    try {
        emit(await runHook(args[1]));
    }
    catch (e) {
        // Fail-open: a crash in the gate must never block a commit or a tool call.
        if (process.env.CTO_DEBUG === '1')
            process.stderr.write(String(e?.stack ?? e) + '\n');
        process.exitCode = 0;
    }
}
else if (args[0] === 'setup') {
    const uninstall = args.includes('--uninstall');
    let chosen;
    const list = flag('--agents');
    if (list)
        chosen = list.split(',').map((s) => s.trim()).filter((s) => agentNames.includes(s));
    else if (!uninstall && process.stdin.isTTY && process.stdout.isTTY && !args.includes('--yes')) {
        const { ask, close } = terminalAsk();
        try {
            chosen = await wizard(ask, lang, detectAgents(), (s) => console.log(s), args.includes('--keys'));
        }
        finally {
            close();
        }
    }
    else if (!uninstall) {
        chosen = detectAgents();
    }
    const r = setup(process.cwd(), lang, { uninstall, agents: chosen });
    (r.code ? process.stderr : process.stdout).write(r.lines.join('\n') + '\n');
    process.exitCode = r.code;
}
else {
    process.stderr.write(t(lang, 'usage') + '\n');
    process.exitCode = args.length ? 1 : 0;
}
