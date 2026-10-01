import type { Signal } from './types.js';

export type Lang = 'zh-TW' | 'en';

/** CTO_LANG > LC_ALL / LANG > OS locale via Intl (Windows has no LANG) > en. zh-* maps to zh-TW. */
export function detectLang(env = process.env): Lang {
  const pick = (v?: string) => {
    if (!v || v === 'C' || v === 'POSIX') return undefined;
    return v.toLowerCase().startsWith('zh') ? 'zh-TW' : v.toLowerCase().startsWith('en') ? 'en' : undefined;
  };
  return (
    pick(env.CTO_LANG) ??
    pick(env.LC_ALL) ??
    pick(env.LANG) ??
    pick(Intl.DateTimeFormat().resolvedOptions().locale) ??
    'en'
  );
}

export const personaDict: Record<Lang, Record<Signal, string>> = {
  'zh-TW': {
    credential_leak: '喂，大天才。你差點把金鑰推進 Git。Commit 已攔下，立刻拿掉。',
    destructive_command: '停手。這個指令有不可逆的破壞性，這次不准執行。',
    infinite_loop: '同樣的錯誤又來了，你們在鬼打牆燒 Token。這次工具呼叫我擋下了，先去看邏輯。',
    architecture_violation: '這次變更偏離了 Sprint 目標。我放你過，但這筆帳記著。',
    test_tampering: '程式沒修好，倒先把測試改弱了？Commit 已攔下。去修程式，不是修測試。',
    code_complexity: '複雜度超標，過度工程化。這次不擋，但趕快重構。',
  },
  en: {
    credential_leak: 'Nice one, genius. You almost pushed a secret into Git. Commit BLOCKED. Remove it.',
    destructive_command: 'Hold it. This command is irreversibly destructive. Not running it.',
    infinite_loop: 'Same error again. You are looping and burning tokens. This tool call is BLOCKED. Fix the logic first.',
    architecture_violation: 'This change drifts from the sprint goal. Letting it through, but I noticed.',
    test_tampering: 'Weakening the tests instead of fixing the code? Commit BLOCKED. Fix the code, not the tests.',
    code_complexity: 'Over-engineered. Not blocking this time, but refactor it.',
  },
};

type Vars = Record<string, string | number>;
type Msg = (v: Vars) => string;

const messages: Record<Lang, Record<string, Msg>> = {
  'zh-TW': {
    reason_402: () => '額度不足',
    reason_auth: () => '認證失敗',
    reason_429: () => '請求過多',
    reason_timeout: () => '逾時',
    reason_5xx: () => '服務錯誤',
    reason_network: () => '連線失敗',
    reason_bad_response: () => '回應格式錯誤',
    dur_1h: () => '1 小時',
    dur_5m: () => '5 分鐘',
    switched: (v) => `[cto] ${v.from} ${v.reason} (${v.status})，${v.dur}內改用 ${v.to}`,
    recovered: (v) => `[cto] ${v.name} 已恢復，切回主要 provider`,
    using: (v) => `[cto] 目前使用 ${v.name} 審查`,
    fail_open: (v) => `[cto] ${v.detail}所有 provider 都無法使用，這次直接放行`,
    fail_open_detail: (v) => `${v.from} ${v.reason} (${v.status})。`,
    bad_request: (v) => `[cto] Jev 拒絕請求 (400)，這次直接放行：${v.msg}`,
    no_keys: () => '[cto] 未設定 Jev API key，全部放行。請設定 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID 或 OPENROUTER_API_KEY',
    detail: (v) => `${v.signal} = ${v.value}（門檻 > ${v.threshold}）`,
    setup_not_git: () => '[cto] 這裡不是 git repository，setup 中止。',
    setup_bad_json: (v) => `[cto] ${v.path} 不是合法 JSON 或 hooks 格式不符，未修改任何檔案。請先修正該檔。`,
    setup_hook: (v) => `[cto] pre-commit 區塊已寫入 ${v.path}`,
    setup_hook_exit: (v) => `[cto] 警告：${v.path} 在 cto 區塊之前有 exit 0，cto 檢查不會執行。請調整該 hook。`,
    setup_gitignore: () => '[cto] .gitignore 已加入 .cto-brain.json 與 debug_stdin.json',
    setup_config: () => '[cto] 已建立 .cto.json（請 commit 給團隊共用）',
    setup_sprint: () => '[cto] 提示：在 .cto.json 填入 sprint_goal 以啟用架構對齊檢查。',
    setup_done: () => '[cto] 安裝完成。',
    uninstall_hook: (v) => `[cto] 已從 ${v.path} 移除 cto 區塊`,
    uninstall_gitignore: () => '[cto] 已從 .gitignore 移除 cto 區塊',
    uninstall_done: () => '[cto] 已解除安裝（.cto.json 保留）。',
    setup_agent: (v) => `[cto] ${v.label} hooks 已寫入 ${v.path}`,
    uninstall_agent: (v) => `[cto] 已從 ${v.path} 移除 ${v.label} hooks`,
    note_codex_trust: () => '[cto] 注意：Codex 只在專案被信任後才執行 .codex/ 的 hook，第一次在此目錄開 codex 時請選擇信任。',
    wiz_intro: () => '\ncto 設定共兩步：1. 選擇要保護的 coding agent　2. 設定 Jev API key\n（git commit 檢查一律安裝，所有 agent 和手動 commit 共用）',
    wiz_step_agents: () => '\n步驟 1/2：要攔截哪些 coding agent 的指令？',
    wiz_agents_hint: () => '輸入編號切換勾選（例如 3 或 1,3），直接 Enter 確認：',
    wiz_invalid: () => '  看不懂這個輸入，請輸入清單上的編號，例如 1 或 1,3。',
    wiz_found: () => '（已偵測到）',
    wiz_step_keys: () => '\n步驟 2/2：Jev API key',
    wiz_keys_present: () => '[cto] 已從環境變數或憑證檔找到 Jev API key，略過這步。要重設請執行 cto setup --keys',
    wiz_keys: (v) => `可用的 provider 如下，至少要設定一個 cto 才會開始檢查。key 存在 ${v.path}，只有你的帳號可讀，不會進 git。`,
    wiz_provider_openrouter: () => 'OpenRouter：最簡單，只要一組 API key（openrouter.ai）',
    wiz_provider_cloudflare: () => 'Cloudflare Workers AI：需要 Account ID 與 API token，且帳號的 AI Gateway 要開啟 Authenticated Gateway',
    wiz_providers_hint: () => '要設定哪些？輸入編號（例如 1 或 1,2），直接 Enter 先跳過：',
    wiz_or_key: () => '  OpenRouter API key: ',
    wiz_cf_account: () => '  Cloudflare Account ID: ',
    wiz_cf_token: () => '  Cloudflare API token: ',
    wiz_checking: (v) => `  正在用一次真實請求驗證 ${v.name}...`,
    wiz_ok: (v) => `  ${v.name} 驗證成功`,
    wiz_fail: (v) => `  ${v.name} 驗證失敗 (${v.status}) ${v.msg}`,
    wiz_save_anyway: () => '  仍要儲存這組 key 嗎？[y/N] ',
    wiz_saved: (v) => `[cto] key 已儲存到 ${v.path}`,
    wiz_no_keys: () => '[cto] 沒有設定任何 key，cto 會全部放行，之後可執行 cto setup --keys 補上。',
    update_available: (v) => `[cto] 有新版 ${v.latest}（目前 ${v.current}），執行 cto update 更新`,
    update_done: () => '[cto] 已更新。已設定過的專案不用重跑 cto setup。',
    usage: () => '用法：cto update | cto --version | cto setup [--agents claude,cursor,gemini,codex] [--keys] [--yes] [--uninstall] | cto --hook <git-commit|AGENT-pre|AGENT-post>',
  },
  en: {
    reason_402: () => 'out of credits',
    reason_auth: () => 'auth failed',
    reason_429: () => 'rate limited',
    reason_timeout: () => 'timed out',
    reason_5xx: () => 'server error',
    reason_network: () => 'network error',
    reason_bad_response: () => 'malformed response',
    dur_1h: () => '1 hour',
    dur_5m: () => '5 minutes',
    switched: (v) => `[cto] ${v.from} ${v.reason} (${v.status}), using ${v.to} for the next ${v.dur}`,
    recovered: (v) => `[cto] ${v.name} recovered, switched back to the primary provider`,
    using: (v) => `[cto] Reviewing with ${v.name}`,
    fail_open: (v) => `[cto] ${v.detail}No provider available, letting this one through`,
    fail_open_detail: (v) => `${v.from} ${v.reason} (${v.status}). `,
    bad_request: (v) => `[cto] Jev rejected the request (400), letting this one through: ${v.msg}`,
    no_keys: () => '[cto] No Jev API key set, everything passes. Set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID or OPENROUTER_API_KEY',
    detail: (v) => `${v.signal} = ${v.value} (threshold > ${v.threshold})`,
    setup_not_git: () => '[cto] Not a git repository, setup aborted.',
    setup_bad_json: (v) => `[cto] ${v.path} is not valid JSON or has an unexpected hooks shape. Nothing was changed. Fix it first.`,
    setup_hook: (v) => `[cto] pre-commit block written to ${v.path}`,
    setup_hook_exit: (v) => `[cto] Warning: ${v.path} has an exit 0 before the cto block, so cto will never run. Adjust that hook.`,
    setup_gitignore: () => '[cto] Added .cto-brain.json and debug_stdin.json to .gitignore',
    setup_config: () => '[cto] Created .cto.json (commit it for the team)',
    setup_sprint: () => '[cto] Tip: set sprint_goal in .cto.json to enable the architecture alignment check.',
    setup_done: () => '[cto] Setup complete.',
    uninstall_hook: (v) => `[cto] Removed the cto block from ${v.path}`,
    uninstall_gitignore: () => '[cto] Removed the cto block from .gitignore',
    uninstall_done: () => '[cto] Uninstalled (.cto.json kept).',
    setup_agent: (v) => `[cto] ${v.label} hooks written to ${v.path}`,
    uninstall_agent: (v) => `[cto] Removed ${v.label} hooks from ${v.path}`,
    note_codex_trust: () => '[cto] Note: Codex only runs .codex/ hooks once the project is trusted. Trust it the first time you open codex here.',
    wiz_intro: () => '\ncto setup has two steps: 1. pick the coding agents to protect  2. set up a Jev API key\n(the git commit check is always installed and covers every agent and manual commits)',
    wiz_step_agents: () => '\nStep 1/2: Which coding agents should have their commands checked?',
    wiz_agents_hint: () => 'Type numbers to toggle (e.g. 3 or 1,3), or press Enter to confirm: ',
    wiz_invalid: () => '  Did not understand that. Type numbers from the list, e.g. 1 or 1,3.',
    wiz_found: () => ' (detected)',
    wiz_step_keys: () => '\nStep 2/2: Jev API key',
    wiz_keys_present: () => '[cto] Found a Jev API key in env or the credentials file, skipping this step. Run cto setup --keys to change it.',
    wiz_keys: (v) => `These providers are available. Set up at least one, or cto checks nothing. Keys are stored in ${v.path}, readable only by you, never in git.`,
    wiz_provider_openrouter: () => 'OpenRouter: easiest, one API key (openrouter.ai)',
    wiz_provider_cloudflare: () => 'Cloudflare Workers AI: Account ID plus API token, and Authenticated Gateway must be on in your AI Gateway',
    wiz_providers_hint: () => 'Which ones? Type numbers (e.g. 1 or 1,2), or press Enter to skip for now: ',
    wiz_or_key: () => '  OpenRouter API key: ',
    wiz_cf_account: () => '  Cloudflare Account ID: ',
    wiz_cf_token: () => '  Cloudflare API token: ',
    wiz_checking: (v) => `  Verifying ${v.name} with one real request...`,
    wiz_ok: (v) => `  ${v.name} OK`,
    wiz_fail: (v) => `  ${v.name} failed (${v.status}) ${v.msg}`,
    wiz_save_anyway: () => '  Save this key anyway? [y/N] ',
    wiz_saved: (v) => `[cto] Keys saved to ${v.path}`,
    wiz_no_keys: () => '[cto] No key set, so cto lets everything through. Run cto setup --keys later.',
    update_available: (v) => `[cto] Version ${v.latest} is available (you have ${v.current}). Run cto update`,
    update_done: () => '[cto] Updated. Projects already set up do not need cto setup again.',
    usage: () => 'Usage: cto update | cto --version | cto setup [--agents claude,cursor,gemini,codex] [--keys] [--yes] [--uninstall] | cto --hook <git-commit|AGENT-pre|AGENT-post>',
  },
};

export function t(lang: Lang, key: string, vars: Vars = {}): string {
  return (messages[lang][key] ?? messages.en[key])(vars);
}
