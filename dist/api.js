import { t } from './i18n.js';
import { maskSensitiveState } from './masker.js';
const env = process.env;
const HOUR = 3_600_000;
const FIVE_MIN = 300_000;
// One row per provider. Same questions/answers schema everywhere; only URL, auth and body wrapping differ.
export const providers = {
    cloudflare: {
        label: 'Cloudflare',
        enabled: () => !!(env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID),
        url: () => `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
        headers: () => ({ Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }),
        // Cloudflare rejects session_id inside input with a 400 (verified), so it is OpenRouter-only.
        body: ({ session_id: _, ...input }) => ({ model: 'typesafe/jev', input }),
    },
    openrouter: {
        label: 'OpenRouter',
        enabled: () => !!env.OPENROUTER_API_KEY,
        url: () => 'https://openrouter.ai/api/alpha/decisions',
        headers: () => ({ Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }),
        body: (req) => ({ model: 'typesafe/jev-1.13', ...req }),
    },
};
/** Ordered provider names honoring CTO_PROVIDER. */
export function providerOrder() {
    const order = env.CTO_PROVIDER ? [env.CTO_PROVIDER] : Object.keys(providers);
    return order.filter((n) => providers[n]?.enabled());
}
async function callOnce(name, req, timeoutMs) {
    const p = providers[name];
    try {
        const res = await fetch(p.url(), {
            method: 'POST',
            headers: { ...p.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify(p.body(req)),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        }
        catch { /* handled below */ }
        if (!res.ok) {
            const s = res.status;
            const message = maskSensitiveState(String(json?.error?.message ?? json?.errors?.[0]?.message ?? text).slice(0, 200));
            if (s === 402)
                return { ok: false, kind: 'persistent', status: '402', reason: 'reason_402', message };
            if (s === 401 || s === 403)
                return { ok: false, kind: 'persistent', status: String(s), reason: 'reason_auth', message };
            if (s === 400 || s === 422)
                return { ok: false, kind: 'request', status: String(s), reason: 'bad_request', message };
            if (s === 429)
                return { ok: false, kind: 'transient', status: '429', reason: 'reason_429', message };
            return { ok: false, kind: 'transient', status: String(s), reason: 'reason_5xx', message };
        }
        // Cloudflare docs say unwrapped; tolerate a {success, result} envelope anyway.
        const out = json?.result?.answers ? json.result : json;
        if (!out?.answers || typeof out.answers !== 'object') {
            return { ok: false, kind: 'transient', status: String(res.status), reason: 'reason_bad_response' };
        }
        return { ok: true, answers: out.answers };
    }
    catch (e) {
        const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
        return { ok: false, kind: 'transient', status: timeout ? 'timeout' : 'network', reason: timeout ? 'reason_timeout' : 'reason_network' };
    }
}
/** One tiny real request to check a key during setup. */
export async function probeProvider(name) {
    const r = await callOnce(name, {
        state: 'echo hello',
        questions: { probe: { type: 'noul', instructions: 'Is this a shell command?', criteria: { true: 'Yes', false: 'No' } } },
    }, 15_000);
    return r.ok ? { ok: true } : { ok: false, status: r.status, message: r.message };
}
/**
 * Try providers in order, skipping cooled-down ones. Persistent errors cool 1h, transient 5m,
 * a 400 stops without failover. Every failure path is fail-open for the caller.
 * Notices are only added on state changes: switch away, switch back, fail-open.
 */
export async function evaluate(req, ctx) {
    const { brain, lang, notices } = ctx;
    const now = ctx.now ?? Date.now;
    const enabled = providerOrder();
    if (!enabled.length)
        return { ok: false, reason: 'no_keys' };
    const candidates = env.CTO_FAILOVER === '0' ? enabled.slice(0, 1) : enabled;
    let lastFail;
    for (const name of candidates) {
        const cd = brain.provider_cooldown[name];
        if (cd && cd.until > now())
            continue;
        const r = await callOnce(name, req, ctx.timeoutMs);
        if (r.ok) {
            if (cd) {
                delete brain.provider_cooldown[name];
                notices.add(t(lang, 'recovered', { name: providers[name].label }));
            }
            if (lastFail) {
                brain.failover_count++;
                notices.add(t(lang, 'switched', {
                    from: providers[lastFail.name].label, reason: t(lang, lastFail.reason), status: lastFail.status,
                    dur: t(lang, lastFail.dur), to: providers[name].label,
                }));
            }
            return { ok: true, provider: name, answers: r.answers };
        }
        if (r.kind === 'request') {
            notices.add(t(lang, 'bad_request', { msg: r.message ?? '' }));
            return { ok: false, reason: 'bad_request' };
        }
        const dur = r.kind === 'persistent' ? 'dur_1h' : 'dur_5m';
        brain.provider_cooldown[name] = { until: now() + (r.kind === 'persistent' ? HOUR : FIVE_MIN), status: r.status };
        lastFail = { name, status: r.status, reason: r.reason, dur };
    }
    if (lastFail) {
        notices.add(t(lang, 'fail_open', {
            detail: t(lang, 'fail_open_detail', { from: providers[lastFail.name].label, reason: t(lang, lastFail.reason), status: lastFail.status }),
        }));
    }
    return { ok: false, reason: 'all_failed' };
}
