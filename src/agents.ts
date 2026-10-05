// One row per coding agent. The verdict logic is shared; each row only maps the agent's
// stdin shape, its blocking convention, and where setup writes its hook config.

export interface HookOutput { code: number; stdout?: string; stderr: string[] }
export interface PreInput { command?: string; sessionId?: string; cwd?: string }
export interface PostInput { command: string; error: string; cwd?: string; sessionId?: string }
/** transcriptPath set: read the turn from the agent's transcript (Claude Code). Unset: use cto's own turn log. */
export interface StopInput { sessionId?: string; cwd?: string; transcriptPath?: string; lastMessage: string; stopHookActive: boolean }
export interface ReplyInput { sessionId?: string; cwd?: string; text: string }

export type AgentName = 'claude' | 'cursor' | 'gemini' | 'codex';
export const PHASES = ['pre', 'post', 'stop', 'edit', 'reply'] as const;
export type Phase = (typeof PHASES)[number];
type Spec = { event: string; matcher?: string };

export interface Agent {
  label: string;
  homeDir: string; // ~/<homeDir> exists => agent is installed
  settings: string; // project-relative config file
  style: 'nested' | 'cursor'; // nested = Claude-style {hooks:{Event:[{matcher,hooks:[...]}]}}
  pre: Spec;
  post?: Spec;
  stop?: Spec; // end of turn: the "done?" check
  edit?: Spec; // after a file edit: earlier failures are marked, the turn log gets the edit
  reply?: Spec; // the agent's final text, for agents whose stop event does not carry it (Cursor)
  note?: string; // i18n key printed after install
  /** The done check reads this agent's own transcript instead of cto's turn log. */
  transcriptTurns?: boolean;
  parsePre(i: any): PreInput;
  parsePost(i: any): PostInput | null;
  parseStop?(i: any): StopInput;
  parseReply?(i: any): ReplyInput;
  /** Files touched by an edit; undefined when the event does not say. */
  parseEdit?(i: any): string[] | undefined;
  /** Session id carried by any event of this agent. */
  session(i: any): string | undefined;
  block(lines: string[]): HookOutput;
  /** How a stop hook sends the agent back to work. */
  stopBlock(lines: string[]): HookOutput;
  notice(msgs: string[]): HookOutput;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const cmdOf = (i: any) => String(i?.tool_input?.command ?? i?.command ?? '');

// Claude, Codex and Gemini share this convention: exit 2 + stderr blocks, exit 0 hides stderr so notices go out as systemMessage.
// For their stop events exit 2 also means "keep working", with stderr as the reason fed back to the agent.
const exit2Block = (lines: string[]): HookOutput => ({ code: 2, stderr: lines });
const systemMessage = (msgs: string[]): HookOutput => ({ code: 0, stdout: JSON.stringify({ systemMessage: msgs.join('\n') }), stderr: [] });
const nestedPre = (i: any): PreInput => ({ command: str(i?.tool_input?.command), sessionId: str(i?.session_id), cwd: str(i?.cwd) });
const sessionId = (i: any) => str(i?.session_id);
const cursorCwd = (i: any) => str(i?.cwd) ?? str(i?.workspace_roots?.[0]);

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
    transcriptTurns: true,
    settings: '.claude/settings.local.json',
    style: 'nested',
    pre: { event: 'PreToolUse', matcher: 'Bash' },
    post: { event: 'PostToolUseFailure', matcher: 'Bash' },
    stop: { event: 'Stop' },
    edit: { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
    parseEdit: (i) => { const p = str(i?.tool_input?.file_path) ?? str(i?.tool_input?.notebook_path); return p ? [p] : undefined; },
    parseStop: (i) => ({
      sessionId: str(i?.session_id),
      cwd: str(i?.cwd),
      transcriptPath: str(i?.transcript_path),
      lastMessage: String(i?.last_assistant_message ?? ''),
      stopHookActive: i?.stop_hook_active === true,
    }),
    parsePre: nestedPre,
    parsePost: (i) => (i?.is_interrupt || !str(i?.error) ? null : { command: cmdOf(i), error: i.error, cwd: str(i?.cwd), sessionId: sessionId(i) }),
    session: sessionId,
    block: exit2Block,
    stopBlock: exit2Block,
    notice: systemMessage,
  },
  cursor: {
    label: 'Cursor',
    homeDir: '.cursor',
    settings: '.cursor/hooks.json',
    style: 'cursor',
    pre: { event: 'beforeShellExecution' },
    post: { event: 'postToolUseFailure' },
    edit: { event: 'afterFileEdit' },
    // stop carries no message text, so the final reply is captured by afterAgentResponse.
    stop: { event: 'stop' },
    reply: { event: 'afterAgentResponse' },
    parseEdit: (i) => { const p = str(i?.file_path); return p ? [p] : undefined; },
    parsePre: (i) => ({ command: str(i?.command), sessionId: str(i?.conversation_id), cwd: cursorCwd(i) }),
    parsePost: (i) =>
      i?.tool_name !== 'Shell' || i?.is_interrupt || !str(i?.error_message)
        ? null
        : { command: cmdOf(i), error: i.error_message, cwd: cursorCwd(i), sessionId: str(i?.conversation_id) },
    parseStop: (i) => ({
      sessionId: str(i?.conversation_id),
      cwd: cursorCwd(i),
      lastMessage: '',
      // loop_count > 0: this stop follows our own follow-up; aborted/error stops are not "done" claims.
      stopHookActive: Number(i?.loop_count ?? 0) > 0 || (i?.status !== undefined && i?.status !== 'completed'),
    }),
    parseReply: (i) => ({ sessionId: str(i?.conversation_id), cwd: cursorCwd(i), text: String(i?.text ?? '') }),
    session: (i) => str(i?.conversation_id),
    // Both documented block paths at once: exit 2 and permission "deny".
    block: (lines) => ({
      code: 2,
      stdout: JSON.stringify({ permission: 'deny', user_message: lines.join('\n'), agent_message: lines.join('\n') }),
      stderr: lines,
    }),
    // A non-empty followup_message is submitted as the next user message, so the agent keeps working.
    stopBlock: (lines) => ({ code: 0, stdout: JSON.stringify({ followup_message: lines.join('\n') }), stderr: [] }),
    notice: (msgs) => ({ code: 0, stdout: JSON.stringify({ permission: 'allow', user_message: msgs.join('\n') }), stderr: [] }),
  },
  gemini: {
    label: 'Gemini CLI',
    homeDir: '.gemini',
    settings: '.gemini/settings.json',
    style: 'nested',
    pre: { event: 'BeforeTool', matcher: 'run_shell_command' },
    post: { event: 'AfterTool', matcher: 'run_shell_command' },
    edit: { event: 'AfterTool', matcher: 'write_file|replace' },
    stop: { event: 'AfterAgent' },
    parseEdit: (i) => { const p = str(i?.tool_input?.file_path); return p ? [p] : undefined; },
    parsePre: nestedPre,
    parsePost: (i) => {
      if (i?.tool_name !== 'run_shell_command') return null;
      const r = i?.tool_response;
      const err = str(r?.error) ?? str(r?.error?.message) ?? nonZeroExit(r?.llmContent);
      return err ? { command: cmdOf(i), error: err, cwd: str(i?.cwd), sessionId: sessionId(i) } : null;
    },
    parseStop: (i) => ({ sessionId: sessionId(i), cwd: str(i?.cwd), lastMessage: String(i?.prompt_response ?? ''), stopHookActive: i?.stop_hook_active === true }),
    session: sessionId,
    block: exit2Block,
    stopBlock: exit2Block, // AfterAgent: exit 2 retries with stderr as the new prompt
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
    // Codex edits through apply_patch; the patch text names each file ("*** Update File: src/a.ts").
    edit: { event: 'PostToolUse', matcher: 'apply_patch' },
    stop: { event: 'Stop' },
    parseEdit: (i) => {
      const files = [...String(i?.tool_input?.command ?? '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
      return files.length ? files : undefined;
    },
    note: 'note_codex_trust',
    parsePre: nestedPre,
    parsePost: (i) => {
      const err = nonZeroExit(i?.tool_response);
      return err ? { command: cmdOf(i), error: err, cwd: str(i?.cwd), sessionId: sessionId(i) } : null;
    },
    parseStop: (i) => ({ sessionId: sessionId(i), cwd: str(i?.cwd), lastMessage: String(i?.last_assistant_message ?? ''), stopHookActive: i?.stop_hook_active === true }),
    session: sessionId,
    block: exit2Block,
    stopBlock: exit2Block,
    notice: systemMessage,
  },
};

export const agentNames = Object.keys(agents) as AgentName[];
export const hookCommand = (agent: AgentName, phase: Phase) => `cto --hook ${agent}-${phase}`;
