// Egress filter: everything sent to Jev or written to disk passes through here.
// Masking is not the verdict; Jev still judges leaks from the [REDACTED: TYPE] labels.
export function maskSensitiveState(raw) {
    return raw
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED: PRIVATE_KEY_BLOCK]')
        .replace(/\bsk_(live|test)_[A-Za-z0-9_]{16,}/g, '[REDACTED: STRIPE_KEY]')
        .replace(/\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED: OPENAI_KEY]')
        .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED: AWS_ACCESS_KEY]')
        .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g, '[REDACTED: GITHUB_TOKEN]')
        .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED: GITHUB_PAT]')
        .replace(/\bnpm_[A-Za-z0-9]{36,}/g, '[REDACTED: NPM_TOKEN]')
        // Lookahead keeps an already-masked value from being masked twice.
        .replace(/\b(\w*(?:PASSWORD|SECRET|TOKEN|KEY))=(?!\[REDACTED)\S+/gi, '$1=[REDACTED: SENSITIVE_VALUE]');
}
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
// Added, removed and context lines all carry real values.
const ENV_LINE = /^([+\- ])(\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*)(\S.*)$/;
/** Mask a unified diff: every NAME=value line in .env / .env.* files, then the generic patterns. */
export function maskDiff(diff) {
    let inEnv = false;
    const lines = diff.split('\n').map((line) => {
        if (line.startsWith('diff --git ')) {
            const m = / b\/(.+)$/.exec(line);
            inEnv = !!m && ENV_FILE.test(m[1]);
            return line;
        }
        if (inEnv && !line.startsWith('+++') && !line.startsWith('---')) {
            const m = ENV_LINE.exec(line);
            if (m)
                return `${m[1]}${m[2]}[REDACTED: ENV_VALUE]`;
        }
        return line;
    });
    return maskSensitiveState(lines.join('\n'));
}
