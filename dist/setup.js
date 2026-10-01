import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { agentNames, agents, hookCommand } from './agents.js';
import { DEFAULT_CONFIG } from './brain.js';
import { t } from './i18n.js';
const START = '# >>> YOUR CTO JEV START >>>';
const END = '# <<< YOUR CTO JEV END <<<';
// Pin the diff format: user config (noprefix, color.diff=always, external diff, textconv) would break parsing and masking.
export const DIFF_CMD = 'git diff --cached --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/';
const HOOK_BODY = `if command -v cto >/dev/null 2>&1; then\n  ${DIFF_CMD} | cto --hook git-commit || exit 1\nfi\n`;
const IGNORE_BODY = '.cto-brain.json\n.cto-brain.json.*tmp\ndebug_stdin.json\n';
const OURS = (cmd) => typeof cmd === 'string' && cmd.startsWith('cto --hook ');
const block = (body) => `${START}\n${body}${END}\n`;
const blockRe = /\n?# >>> YOUR CTO JEV START >>>\n[\s\S]*?# <<< YOUR CTO JEV END <<<\n?/;
export function removeBlock(content) {
    return content.replace(blockRe, (m) => (m.startsWith('\n') && m.endsWith('\n') ? '\n' : ''));
}
export function appendBlock(content, body) {
    const base = removeBlock(content);
    return (base && !base.endsWith('\n') ? base + '\n' : base) + block(body);
}
/** An exit 0 outside our block means the appended block never runs. */
export function hasEarlyExit(content) {
    return /^\s*exit\s+0\b/m.test(removeBlock(content));
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** Hooks dir honoring core.hooksPath (via --git-path). Husky's generated .husky/_ is replaced on install, so use .husky. */
export function hooksDir(root) {
    const dir = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks');
    return basename(dir) === '_' && basename(dirname(dir)) === '.husky' ? dirname(dir) : dir;
}
/** Agents whose home config dir exists. */
export function detectAgents(home = homedir()) {
    return agentNames.filter((n) => existsSync(join(home, agents[n].homeDir)));
}
function readSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Settings must be an object; the hook events cto writes must be arrays if present. Checked before anything is written. */
function validShape(json, name) {
    if (!isObj(json))
        return false;
    if (json.hooks === undefined)
        return true;
    if (!isObj(json.hooks))
        return false;
    const a = agents[name];
    return [a.pre, a.post].every((spec) => !spec || json.hooks[spec.event] === undefined || Array.isArray(json.hooks[spec.event]));
}
function writeOrRemove(path, settings) {
    const meaningful = Object.keys(settings).filter((k) => k !== 'version');
    if (meaningful.length)
        return writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    unlinkSync(path);
    try {
        if (!readdirSync(dirname(path)).length)
            rmdirSync(dirname(path));
    }
    catch { /* keep dir */ }
}
function installAgent(settings, name) {
    const a = agents[name];
    settings.hooks ??= {};
    if (a.style === 'cursor')
        settings.version ??= 1;
    for (const phase of ['pre', 'post']) {
        const spec = a[phase];
        if (!spec)
            continue;
        const command = hookCommand(name, phase);
        const arr = (settings.hooks[spec.event] ??= []);
        if (a.style === 'cursor') {
            if (!arr.some((h) => h?.command === command))
                arr.push({ command });
        }
        else if (!arr.some((m) => m?.hooks?.some((h) => h?.command === command))) {
            arr.push({ ...(spec.matcher && { matcher: spec.matcher }), hooks: [{ type: 'command', command }] });
        }
    }
}
/** Remove every cto hook from a settings object (both styles). Returns whether anything changed. */
function uninstallHooks(settings) {
    if (!settings.hooks || typeof settings.hooks !== 'object')
        return false;
    let touched = false;
    for (const [event, arr] of Object.entries(settings.hooks)) {
        if (!Array.isArray(arr))
            continue;
        const kept = arr.flatMap((m) => {
            if (OURS(m?.command)) {
                touched = true;
                return [];
            } // cursor style
            if (!Array.isArray(m?.hooks) || !m.hooks.some((h) => OURS(h?.command)))
                return [m];
            touched = true;
            const hooks = m.hooks.filter((h) => !OURS(h?.command));
            return hooks.length ? [{ ...m, hooks }] : [];
        });
        if (kept.length)
            settings.hooks[event] = kept;
        else
            delete settings.hooks[event];
    }
    if (touched && !Object.keys(settings.hooks).length)
        delete settings.hooks;
    return touched;
}
export function setup(cwd, lang, opts = {}) {
    const lines = [];
    let root;
    try {
        root = git(cwd, 'rev-parse', '--show-toplevel');
    }
    catch {
        return { code: 1, lines: [t(lang, 'setup_not_git')] };
    }
    const rel = (p) => relative(root, p) || p;
    // Validate every config file we may touch before writing anything.
    const targets = opts.uninstall ? agentNames : (opts.agents ?? []);
    const settings = new Map();
    for (const name of targets) {
        const path = join(root, agents[name].settings);
        const json = readSettings(path);
        if (json === null || !validShape(json, name))
            return { code: 1, lines: [t(lang, 'setup_bad_json', { path: rel(path) })] };
        settings.set(name, { path, json });
    }
    const hookPath = join(hooksDir(root), 'pre-commit');
    const ignorePath = join(root, '.gitignore');
    if (opts.uninstall) {
        if (existsSync(hookPath)) {
            const c = readFileSync(hookPath, 'utf8');
            if (blockRe.test(c)) {
                const rest = removeBlock(c);
                if (!rest.trim() || rest.trim() === '#!/bin/sh')
                    unlinkSync(hookPath);
                else
                    writeFileSync(hookPath, rest);
                lines.push(t(lang, 'uninstall_hook', { path: rel(hookPath) }));
            }
        }
        for (const [name, { path, json }] of settings) {
            if (!existsSync(path) || !uninstallHooks(json))
                continue;
            writeOrRemove(path, json);
            lines.push(t(lang, 'uninstall_agent', { label: agents[name].label, path: rel(path) }));
        }
        if (existsSync(ignorePath)) {
            const c = readFileSync(ignorePath, 'utf8');
            if (blockRe.test(c)) {
                const rest = removeBlock(c);
                if (rest.trim())
                    writeFileSync(ignorePath, rest);
                else
                    unlinkSync(ignorePath);
                lines.push(t(lang, 'uninstall_gitignore'));
            }
        }
        lines.push(t(lang, 'uninstall_done'));
        return { code: 0, lines };
    }
    // 1. git pre-commit: covers every agent and humans alike. Append a marked block, never overwrite.
    if (existsSync(hookPath)) {
        const c = readFileSync(hookPath, 'utf8');
        writeFileSync(hookPath, appendBlock(c, HOOK_BODY));
        if (hasEarlyExit(c))
            lines.push(t(lang, 'setup_hook_exit', { path: rel(hookPath) }));
    }
    else {
        mkdirSync(dirname(hookPath), { recursive: true });
        writeFileSync(hookPath, '#!/bin/sh\n' + block(HOOK_BODY));
    }
    chmodSync(hookPath, 0o755);
    lines.push(t(lang, 'setup_hook', { path: rel(hookPath) }));
    // 2. Agent hooks: merge, keep everything else.
    for (const [name, { path, json }] of settings) {
        installAgent(json, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
        lines.push(t(lang, 'setup_agent', { label: agents[name].label, path: rel(path) }));
        const note = agents[name].note;
        if (note)
            lines.push(t(lang, note));
    }
    // 3. .gitignore block.
    writeFileSync(ignorePath, appendBlock(existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '', IGNORE_BODY));
    lines.push(t(lang, 'setup_gitignore'));
    // 4. Shared config, created once and never removed.
    const cfgPath = join(root, '.cto.json');
    let goal = '';
    if (!existsSync(cfgPath)) {
        writeFileSync(cfgPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
        lines.push(t(lang, 'setup_config'));
    }
    else {
        try {
            goal = JSON.parse(readFileSync(cfgPath, 'utf8')).sprint_goal ?? '';
        }
        catch { /* keep empty */ }
    }
    if (!String(goal).trim())
        lines.push(t(lang, 'setup_sprint'));
    lines.push(t(lang, 'setup_done'));
    return { code: 0, lines };
}
