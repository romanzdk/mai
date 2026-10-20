export type PolicyDecision = { allow: true } | { allow: false; reason: string };

interface Rule {
  tool: string;
  pattern: RegExp;
  reason: string;
}

// Commands that need the user's approval (docs/DECISIONS.md 004). Until approval cards exist
// (M3) these are denied outright. Matching is deliberately broad: a false positive costs one
// approval, a false negative can cost data.
export const RULES: Rule[] = [
  { tool: 'Bash', pattern: /(^|[\s;&|(`])(sudo|doas|su)\s/, reason: 'runs as root' },
  {
    tool: 'Bash',
    pattern: /(^|[\s;&|(`])(rm|rmdir|unlink|shred|srm|trash)(\s|$)/,
    reason: 'deletes files',
  },
  { tool: 'Bash', pattern: /\bfind\b[^;&|]*\s-(delete|exec\s+rm)\b/, reason: 'deletes files' },
  {
    tool: 'Bash',
    pattern: /\bgit\s+(push|clean)\b/,
    reason: 'pushes to a remote or deletes files',
  },
  { tool: 'Bash', pattern: /\bgit\s+reset\s+--hard\b/, reason: 'discards uncommitted work' },
  { tool: 'Bash', pattern: /\b(mkfs|dd\s+if=|diskutil\s+erase)/, reason: 'can wipe a disk' },
];

export function checkToolUse(tool: string, input: unknown): PolicyDecision {
  const command =
    tool === 'Bash' && typeof input === 'object' && input !== null
      ? String((input as { command?: unknown }).command ?? '')
      : '';
  for (const rule of RULES) {
    if (rule.tool === tool && rule.pattern.test(command)) {
      return { allow: false, reason: `${rule.reason}: \`${command}\` needs your approval` };
    }
  }
  return { allow: true };
}
