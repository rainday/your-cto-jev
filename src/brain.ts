import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Signal, TurnAction } from './types.js';

export interface CtoConfig {
  sprint_goal: string;
  thresholds: Record<Signal, number>;
}

export interface RecentError { command: string; error: string; at: string; edited_after?: boolean; warned?: boolean }
export interface Cooldown { until: number; status: string }

export interface Brain {
  recent_errors: RecentError[];
  blocked_attempts: number;
  skipped_attempts: number;
  failover_count: number;
  provider_cooldown: Record<string, Cooldown>;
  notified_sessions: string[];
  checks?: number; // checks Jev answered (any hook)
  /** cto's own per-session turn log, for agents whose transcript format is not public (Cursor, Gemini CLI, Codex). */
  turns?: Record<string, { at: string; actions: TurnAction[]; reply?: string }>;
  last_check_at?: string;
  /** Checklist items the done check already judged ("file:text"), so an uncommitted tick is judged once, not every turn. */
  judged_items?: string[];
}

export const DEFAULT_CONFIG: CtoConfig = {
  sprint_goal: '',
  thresholds: {
    credential_leak: 0.5,
    destructive_command: 0.7,
    infinite_loop: 0.6,
    architecture_violation: 0.85,
    test_tampering: 0.8,
    done_unverified: 0.6,
    code_complexity: 2,
  },
};

const emptyBrain = (): Brain => ({
  recent_errors: [],
  blocked_attempts: 0,
  skipped_attempts: 0,
  failover_count: 0,
  provider_cooldown: {},
  notified_sessions: [],
});

/** Nearest ancestor holding .cto.json or .git; falls back to start. No git spawn. */
export function findRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.cto.json')) || existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

export function loadConfig(root: string): CtoConfig {
  const raw = readJson(join(root, '.cto.json')) ?? {};
  return {
    sprint_goal: typeof raw.sprint_goal === 'string' ? raw.sprint_goal : '',
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(raw.thresholds ?? {}) },
  };
}

/** Corrupt or missing state rebuilds as empty: the gate must never crash on its own bookkeeping. */
export function loadBrain(root: string): Brain {
  const raw = readJson(join(root, '.cto-brain.json'));
  return raw && typeof raw === 'object' ? { ...emptyBrain(), ...raw } : emptyBrain();
}

// ---------- user-level credentials ----------
// GUI-launched agents and git clients often do not inherit shell env vars, so keys set in .zshrc
// never reach the hook. A per-user file outside every repo fixes that without touching rc files.

export const CREDENTIAL_KEYS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'OPENROUTER_API_KEY', 'TYPESAFE_API_KEY'] as const;
export type Credentials = Partial<Record<(typeof CREDENTIAL_KEYS)[number], string>>;

export function credentialsPath(env = process.env): string {
  const base = env.APPDATA ?? env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'your-cto-jev', 'credentials.json');
}

export function loadCredentials(): Credentials {
  const raw = readJson(credentialsPath()) ?? {};
  return Object.fromEntries(CREDENTIAL_KEYS.filter((k) => typeof raw[k] === 'string' && raw[k]).map((k) => [k, raw[k]]));
}

/** Env vars win; the file only fills what is missing. */
export function applyCredentials(env = process.env): void {
  for (const [k, v] of Object.entries(loadCredentials())) if (!env[k]) env[k] = v;
}

/** Replace the stored keys with exactly `c`; personal prefs in the same file are kept. */
export function saveCredentials(c: Credentials): string {
  const raw = readJson(credentialsPath()) ?? {};
  for (const k of CREDENTIAL_KEYS) delete raw[k];
  return writeUserFile({ ...raw, ...c });
}

// Personal preferences live next to the keys: they are per person, not per repo.
export interface Prefs {
  provider_order?: string[]; // providers to use, in failover order; absent = every provider with a key, default order
  lang?: 'zh-TW' | 'en'; // absent = auto-detect
}

export function loadPrefs(): Prefs {
  const raw = readJson(credentialsPath()) ?? {};
  return {
    ...(Array.isArray(raw.provider_order) && { provider_order: raw.provider_order.filter((p: unknown) => typeof p === 'string') }),
    ...((raw.lang === 'zh-TW' || raw.lang === 'en') && { lang: raw.lang }),
  };
}

export function savePrefs(p: Prefs): string {
  const raw = readJson(credentialsPath()) ?? {};
  delete raw.provider_order;
  delete raw.lang;
  return writeUserFile({ ...raw, ...p });
}

function writeUserFile(data: object): string {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return path;
}

/**
 * Atomic write via per-process tmp + rename. No file lock (spec section 7): parallel hooks race, last write wins.
 * Never throws: losing bookkeeping is fine, but an exception here would turn a block into a fail-open pass.
 */
export function saveBrain(root: string, brain: Brain): void {
  const path = join(root, '.cto-brain.json');
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(brain, null, 2) + '\n');
    renameSync(tmp, path);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

/** Failures older than this are history, not a loop. */
export const RECENT_ERROR_WINDOW_MS = 15 * 60_000;
export function freshErrors(brain: Brain, now = Date.now()): RecentError[] {
  return brain.recent_errors.filter((e) => now - Date.parse(e.at) < RECENT_ERROR_WINDOW_MS);
}
