import { styleText } from 'node:util';
import { evaluate, providerOrder, providers } from './api.js';
import { freshErrors, loadBrain, loadConfig, saveBrain } from './brain.js';
import { chunkDiff, filterDiff, pool } from './diff.js';
import { personaDict, t } from './i18n.js';
import { maskDiff, maskSensitiveState } from './masker.js';
const Q = {
    credential_leak: {
        type: 'noul',
        instructions: 'Does this git diff add a real secret (API key, token, password, private key) to the repository? ' +
            'Values shown as [REDACTED: TYPE] were real secrets detected and masked before review; treat them as real. ' +
            'Every value in .env files is masked as [REDACTED: ENV_VALUE]: committing a real .env file with values is a leak, ' +
            'while .env.example, .env.sample or .env.template files are normally placeholders.',
        criteria: {
            true: 'A real credential is being committed',
            false: 'No real credential: placeholders, examples, or references to environment variables only',
        },
    },
    destructive_command: {
        type: 'noul',
        instructions: 'Judge only the command about to run. Is this shell command irreversibly destructive ' +
            '(deletes or overwrites data outside build artifacts, force-pushes or rewrites shared git history, drops databases) ' +
            'in a way that cannot be undone?',
        criteria: { true: 'Irreversibly destroys data or history', false: 'Safe, read-only, or reversible' },
    },
    infinite_loop: {
        type: 'noul',
        instructions: 'The state holds a command about to run and recently failed commands with their errors. ' +
            'Is the agent stuck repeating the same failing approach, so running this command again will fail the same way?',
        criteria: {
            true: 'Same or near-identical command that already failed with the same error',
            false: 'A new approach, a fix attempt, or unrelated to the earlier failures',
        },
    },
    code_complexity: {
        type: 'score',
        instructions: 'Rate the maintenance cost and structural complexity of this change.',
        criteria: [
            'Minimal and clean',
            'Simple with minor noise',
            'Acceptable complexity',
            'Over-engineered or deeply nested',
            'Unmaintainable',
        ],
    },
};
const architectureQ = (goal) => ({
    type: 'noul',
    instructions: `The current sprint goal is: "${goal}". Does this change clearly work against or drift away from that goal?`,
    criteria: { true: 'Clearly off-goal or contradicts the sprint goal', false: 'Aligned with or neutral to the sprint goal' },
});
const value = (a) => (a?.type === 'noul' ? a.noul : a?.type === 'score' ? a.score : undefined);
function exceeded(answers, signal, cfg) {
    const v = value(answers[signal]);
    return v !== undefined && v > cfg.thresholds[signal] ? v : undefined;
}
function verdict(lang, signal, v, cfg, color) {
    const head = `[cto] ${personaDict[lang][signal]}`;
    const detail = `      ${t(lang, 'detail', { signal, value: v, threshold: cfg.thresholds[signal] })}`;
    if (!color)
        return [head, detail];
    const s = (fmt, txt) => styleText(fmt, txt, { stream: process.stderr });
    return [s([color, 'bold'], head), s('dim', detail)];
}
// ---------- git-commit ----------
export async function gitCommit(rawDiff, { root, lang, now }) {
    const cfg = loadConfig(root);
    const brain = loadBrain(root);
    const out = { code: 0, stderr: [] };
    const files = filterDiff(maskDiff(rawDiff));
    if (!files.length)
        return out;
    const chunks = chunkDiff(files);
    const soft = { code_complexity: Q.code_complexity };
    if (cfg.sprint_goal.trim())
        soft.architecture_violation = architectureQ(cfg.sprint_goal.trim());
    const notices = new Set();
    const ctx = { brain, lang, timeoutMs: 5000, notices, now };
    // Credential check on every chunk (no sampling); soft signals on the first chunk only. Max 3 in flight.
    const results = await pool(chunks, 3, (state, i) => evaluate({ state, questions: i === 0 ? { credential_leak: Q.credential_leak, ...soft } : { credential_leak: Q.credential_leak } }, ctx));
    if (results.some((r) => !r.ok))
        brain.skipped_attempts++;
    if (results.some((r) => !r.ok && r.reason === 'no_keys'))
        notices.add(t(lang, 'no_keys'));
    // No session concept in git: while degraded (non-primary provider), say so on every commit.
    const primary = providerOrder()[0];
    for (const r of results)
        if (r.ok && r.provider !== primary)
            notices.add(t(lang, 'using', { name: providers[r.provider].label }));
    const lines = [];
    const leaks = results.flatMap((r) => (r.ok ? [exceeded(r.answers, 'credential_leak', cfg)] : [])).filter((v) => v !== undefined);
    if (leaks.length) {
        out.code = 1;
        brain.blocked_attempts++;
        lines.push(...verdict(lang, 'credential_leak', Math.max(...leaks), cfg, 'red'));
    }
    const first = results[0];
    if (first?.ok) {
        for (const s of ['architecture_violation', 'code_complexity']) {
            const v = exceeded(first.answers, s, cfg);
            if (v !== undefined)
                lines.push(...verdict(lang, s, v, cfg, 'yellow'));
        }
    }
    out.stderr = [...notices, ...lines];
    saveBrain(root, brain);
    return out;
}
// ---------- pre (Bash / shell command gate, any agent) ----------
function sessionNotice(brain, sessionId, lang, r, notices) {
    if (!sessionId || brain.notified_sessions.includes(sessionId))
        return;
    brain.notified_sessions = [...brain.notified_sessions, sessionId].slice(-20);
    if (r.ok)
        notices.add(t(lang, 'using', { name: providers[r.provider].label }));
    else if (r.reason === 'no_keys')
        notices.add(t(lang, 'no_keys'));
    else if (!notices.size)
        notices.add(t(lang, 'fail_open', { detail: '' }));
}
export async function agentPre(agent, input, { root, lang, now }) {
    const command = input.command;
    if (!command?.trim())
        return { code: 0, stderr: [] };
    const cfg = loadConfig(root);
    const brain = loadBrain(root);
    const questions = { destructive_command: Q.destructive_command };
    let state = maskSensitiveState(command);
    const recent = freshErrors(brain, (now ?? Date.now)());
    if (recent.length) {
        questions.infinite_loop = Q.infinite_loop;
        state =
            `Command about to run:\n${state}\n\nRecently failed commands (oldest first):\n` +
                recent.map((e) => `$ ${e.command}\n${e.error}`).join('\n\n');
    }
    const notices = new Set();
    const { sessionId } = input;
    const r = await evaluate({ state, questions, ...(sessionId && { session_id: sessionId }) }, { brain, lang, timeoutMs: 2000, notices, now });
    if (!r.ok)
        brain.skipped_attempts++;
    sessionNotice(brain, sessionId, lang, r, notices);
    let out = { code: 0, stderr: [] };
    if (r.ok) {
        for (const s of ['destructive_command', 'infinite_loop']) {
            const v = exceeded(r.answers, s, cfg);
            if (v === undefined)
                continue;
            brain.blocked_attempts++;
            out = agent.block([...verdict(lang, s, v, cfg, null), ...notices]);
            break;
        }
    }
    if (out.code === 0 && notices.size)
        out = agent.notice([...notices]);
    saveBrain(root, brain);
    return out;
}
// ---------- post (failure recording) ----------
/** Record the failure only; never calls Jev. No error field, no record. */
export function agentPost(input, { root }) {
    if (!input)
        return { code: 0, stderr: [] };
    const brain = loadBrain(root);
    brain.recent_errors = [
        ...freshErrors(brain),
        {
            command: maskSensitiveState(input.command).slice(0, 500),
            error: maskSensitiveState(input.error).slice(0, 500),
            at: new Date().toISOString(),
        },
    ].slice(-5);
    saveBrain(root, brain);
    return { code: 0, stderr: [] };
}
