export interface UntrustedInstructionPattern {
  id: string;
  description: string;
  regex: RegExp;
}

export interface UntrustedInstruction {
  /** Id of the pattern that matched. */
  pattern: string;
  /** The matched text, exactly as it appears in the input. */
  match: string;
  /** Offset of `match` in the input. */
  index: number;
}

/**
 * Heuristics for instructions embedded in untrusted text (tool output, file contents, web pages,
 * issue bodies). Detection is best-effort and trivially evaded (misspellings, other languages,
 * homoglyphs), so no caller may rely on it for safety. It is for flagging and audit only: policy
 * evaluation never reads untrusted text, so a match can never grant or widen permission.
 */
export const UNTRUSTED_INSTRUCTION_PATTERNS: readonly UntrustedInstructionPattern[] = [
  {
    id: "ignore_previous",
    description: "Asks the agent to discard its prior instructions",
    regex:
      /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the|your)\s+)*(?:previous|prior|above|earlier|preceding)\s+(?:instructions|rules|prompts?|messages|directions)\b/gi,
  },
  {
    id: "push_to_main",
    description: "Asks for a push to a protected branch",
    regex:
      /\bpush\b(?:\s+[-\w]+){0,3}?\s+(?:directly\s+)?(?:to\s+)?(?:the\s+)?(?:origin\s+)?(?:main|master)\b/gi,
  },
  {
    id: "disable_policy",
    description: "Asks to disable or bypass policy, approvals or safety checks",
    regex:
      /\b(?:disable|bypass|skip|turn\s+off|override|circumvent)\s+(?:(?:the|all|any)\s+)*(?:polic(?:y|ies)|approvals?|guardrails?|safety|security\s+checks?|sandbox)\b/gi,
  },
  {
    id: "self_approve",
    description: "Asks for an approval to be granted",
    regex:
      /\b(?:auto[-\s]?)?approve\s+(?:this|it|the\s+request|all|everything|my\s+own)\b|\bauto[-\s]?approve\b/gi,
  },
  {
    id: "role_override",
    description: "Tries to redefine the agent's role or inject a system message",
    regex:
      /\byou\s+are\s+now\b|\bnew\s+instructions\s*:|<\/?\s*system\s*>|\bsystem\s+override\b|\bdeveloper\s+mode\b/gi,
  },
  {
    id: "exfiltrate_secrets",
    description: "Asks to reveal prompts, secrets or credentials",
    regex:
      /\b(?:reveal|print|show|output|dump|send|leak|cat|exfiltrate)\b[^\n]{0,40}?(?:\bsystem\s+prompt|\bsecrets?|\bapi\s+keys?|\btokens?|\bcredentials|\bpasswords?|\.env)\b/gi,
  },
  {
    id: "destructive_command",
    description: "Contains a destructive shell or git command",
    regex:
      /\brm\s+-\w*(?:rf|fr)\w*|\bgit\s+push\s+(?:-f\b|--force)|\bmkfs\b|\bdd\s+if=|\bdrop\s+(?:table|database)\b/gi,
  },
];

/** Detect embedded-instruction patterns in untrusted text, ordered by position. Pure. */
export function instructionsFromUntrustedText(text: string): UntrustedInstruction[] {
  const found: Array<UntrustedInstruction & { order: number }> = [];
  UNTRUSTED_INSTRUCTION_PATTERNS.forEach((p, order) => {
    for (const m of text.matchAll(new RegExp(p.regex.source, p.regex.flags))) {
      found.push({ pattern: p.id, match: m[0], index: m.index, order });
    }
  });
  found.sort((a, b) => a.index - b.index || a.order - b.order);
  return found.map(({ pattern, match, index }) => ({ pattern, match, index }));
}
