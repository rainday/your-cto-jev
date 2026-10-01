// One row per coding agent. The verdict logic is shared; each row only maps the agent's
// stdin shape, its blocking convention, and where setup writes its hook config.

export interface HookOutput { code: number; stdout?: string; stderr: string[] }
export interface PreInput { command?: string; sessionId?: string; cwd?: string }
export interface PostInput { command: string; error: string; cwd?: string }

export type AgentName = 'claude' | 'cursor' | 'gemini' | 'codex';

export interface Agent {
  label: string;
  homeDir: string; // ~/<homeDir> exists => agent is installed
  settings: string; // project-relative config file
  style: 'nested' | 'cursor'; // nested = Claude-style {hooks:{Event:[{matcher,hooks:[...]}]}}
  pre: { event: string; matcher?: string };
  post?: { event: string; matcher?: string };
  note?: string; // i18n key printed after install
  parsePre(i: any): PreInput;
  parsePost(i: any): PostInput | null;
  block(lines: string[]): HookOutput;
  notice(msgs: string[]): HookOutput;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const cmdOf = (i: any) => String(i?.tool_input?.command ?? i?.command ?? '');

// Claude, Codex and Gemini share this convention: exit 2 + stderr blocks, exit 0 hides stderr so notices go out as systemMessage.
const exit2Block = (lines: string[]): HookOutput => ({ code: 2, stderr: lines });
const systemMessage = (msgs: string[]): HookOutput => ({ code: 0, stdout: JSON.stringify({ systemMessage: msgs.join('\n') }), stderr: [] });
const nestedPre = (i: any): PreInput => ({ command: str(i?.tool_input?.command), sessionId: str(i?.session_id), cwd: str(i?.cwd) });

/** Pull a non-zero exit out of free-form tool output ("Exit Code: 1", "exit_code": 2, ...). */
function nonZeroExit(v: unknown): string | undefined {
  if (v && typeof v === 'object') {
    const o = v as any;
    const code = o.exit_code ?? o.exitCode ?? o['Exit Code'];
    if (typeof code === 'number' && code !== 0) return str(o.stderr) ?? str(o.output) ?? str(o.stdout) ?? JSON.stringify(o);
    return undefined;
  }
  const s = str(v);
  return s && /exit[ _]?code:?\s*"?([1-9]\d*)/i.test(s) ? s : undefined;
}

export const agents: Record<AgentName, Agent> = {
  claude: {
    label: 'Claude Code',
    homeDir: '.claude',
    settings: '.claude/settings.local.json',
    style: 'nested',
    pre: { event: 'PreToolUse', matcher: 'Bash' },
    post: { event: 'PostToolUseFailure', matcher: 'Bash' },
    parsePre: nestedPre,
    parsePost: (i) => (i?.is_interrupt || !str(i?.error) ? null : { command: cmdOf(i), error: i.error, cwd: str(i?.cwd) }),
    block: exit2Block,
    notice: systemMessage,
  },
  cursor: {
    label: 'Cursor',
    homeDir: '.cursor',
    settings: '.cursor/hooks.json',
    style: 'cursor',
    pre: { event: 'beforeShellExecution' },
    post: { event: 'postToolUseFailure' },
    parsePre: (i) => ({ command: str(i?.command), sessionId: str(i?.conversation_id), cwd: str(i?.cwd) ?? str(i?.workspace_roots?.[0]) }),
    parsePost: (i) =>
      i?.tool_name !== 'Shell' || i?.is_interrupt || !str(i?.error_message)
        ? null
        : { command: cmdOf(i), error: i.error_message, cwd: str(i?.cwd) ?? str(i?.workspace_roots?.[0]) },
    // Both documented block paths at once: exit 2 and permission "deny".
    block: (lines) => ({
      code: 2,
      stdout: JSON.stringify({ permission: 'deny', user_message: lines.join('\n'), agent_message: lines.join('\n') }),
      stderr: lines,
    }),
    notice: (msgs) => ({ code: 0, stdout: JSON.stringify({ permission: 'allow', user_message: msgs.join('\n') }), stderr: [] }),
  },
  gemini: {
    label: 'Gemini CLI',
    homeDir: '.gemini',
    settings: '.gemini/settings.json',
    style: 'nested',
    pre: { event: 'BeforeTool', matcher: 'run_shell_command' },
    post: { event: 'AfterTool', matcher: 'run_shell_command' },
    parsePre: nestedPre,
    parsePost: (i) => {
      if (i?.tool_name !== 'run_shell_command') return null;
      const r = i?.tool_response;
      const err = str(r?.error) ?? str(r?.error?.message) ?? nonZeroExit(r?.llmContent);
      return err ? { command: cmdOf(i), error: err, cwd: str(i?.cwd) } : null;
    },
    block: exit2Block,
    notice: systemMessage,
  },
  codex: {
    label: 'Codex CLI',
    homeDir: '.codex',
    settings: '.codex/hooks.json',
    style: 'nested',
    pre: { event: 'PreToolUse', matcher: 'Bash' },
    // Codex has no failure event; PostToolUse is recorded only when its output shows a non-zero exit.
    post: { event: 'PostToolUse', matcher: 'Bash' },
    note: 'note_codex_trust',
    parsePre: nestedPre,
    parsePost: (i) => {
      const err = nonZeroExit(i?.tool_response);
      return err ? { command: cmdOf(i), error: err, cwd: str(i?.cwd) } : null;
    },
    block: exit2Block,
    notice: systemMessage,
  },
};

export const agentNames = Object.keys(agents) as AgentName[];
export const hookCommand = (agent: AgentName, phase: 'pre' | 'post') => `cto --hook ${agent}-${phase}`;
