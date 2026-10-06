export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[] } // ordered scale; answer.score is a float expected index, 0-based
  | { type: 'choice'; instructions: string; criteria: Record<string, string> };

export interface JevRequest {
  state: string;
  questions: Record<string, JevQuestion>;
  session_id?: string;
}

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number; cost?: number };
}

/** One step of an agent's turn, as seen by the done check. */
export type TurnAction = { kind: 'edit'; file: string } | { kind: 'run'; command: string; ok: boolean; tail: string };

/** A markdown checklist item newly marked done ("- [x]"), with the checklist lines nested under it. */
export interface Ticked { file: string; text: string; children: string[] }

export type Signal =
  | 'credential_leak'
  | 'destructive_command'
  | 'infinite_loop'
  | 'architecture_violation'
  | 'test_tampering'
  | 'done_unverified'
  | 'code_complexity';
