import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type PolicyDecision =
  | { allow: true }
  | { allow: false; ruleId: string; reason: string; command: string };

export interface PolicyContext {
  home: string;
  // Deletes strictly inside this folder need no approval (docs/DECISIONS.md 004).
  jobDir?: string;
}

interface Rule {
  id: string;
  tool: string;
  pattern: RegExp;
  reason: string;
}

// Matching is deliberately broad: a false positive costs one approval, a false negative can
// cost data. ponytail: regex screen over shell text, not a shell parser; move to a real parser
// (or sandboxed execution) if workers start writing deletes these miss.
const DELETE_PATTERN = /(^|[\s;&|(`])(rm|rmdir|unlink|shred|srm|trash)(\s|$)/;

export const RULES: Rule[] = [
  { id: 'sudo', tool: 'Bash', pattern: /(^|[\s;&|(`])(sudo|doas|su)\s/, reason: 'runs as root' },
  {
    id: 'delete',
    tool: 'Bash',
    pattern: DELETE_PATTERN,
    reason: 'deletes files',
  },
  {
    id: 'find-delete',
    tool: 'Bash',
    pattern: /\bfind\b[^;&|]*\s-(delete|exec\s+rm)\b/,
    reason: 'deletes files',
  },
  { id: 'git-push', tool: 'Bash', pattern: /\bgit\s+push\b/, reason: 'pushes to a remote' },
  { id: 'git-clean', tool: 'Bash', pattern: /\bgit\s+clean\b/, reason: 'deletes untracked files' },
  {
    id: 'git-reset-hard',
    tool: 'Bash',
    pattern: /\bgit\s+reset\s+--hard\b/,
    reason: 'discards uncommitted work',
  },
  {
    id: 'disk',
    tool: 'Bash',
    pattern: /\b(mkfs|dd\s+if=|diskutil\s+erase)/,
    reason: 'can wipe a disk',
  },
];

const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'unlink']);

// Words of one shell segment, or null when the shell could expand it into something else
// (quotes, variables, substitutions, globs, braces). Those always go to approval.
function words(segment: string): string[] | null {
  if (/[$`\\'"*?[\]{}<>]/.test(segment)) return null;
  return segment.split(/\s+/).filter(Boolean);
}

// Follows symlinks on the longest existing prefix, so `link/` pointing outside is caught.
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPath(parent), basename(path));
  }
}

function deletesOnlyInside(command: string, ctx: PolicyContext): boolean {
  if (!ctx.jobDir) return false;
  const root = realPath(ctx.jobDir);
  const segments = command.split(/&&|\|\||[;|&\n]/).map((s) => s.trim());
  for (const segment of segments) {
    if (!DELETE_PATTERN.test(segment)) continue;
    const w = words(segment);
    if (!w || !DELETE_COMMANDS.has(w[0] ?? '')) return false;
    const targets = w.slice(1).filter((a) => !a.startsWith('-'));
    if (targets.length === 0) return false;
    for (const target of targets) {
      const expanded =
        target === '~' || target.startsWith('~/') ? ctx.home + target.slice(1) : target;
      // Relative paths are never trusted: the Bash tool keeps its own working directory
      // between calls, which the hook cannot see.
      if (!isAbsolute(expanded)) return false;
      const real = realPath(resolve(expanded));
      if (!real.startsWith(root + sep)) return false;
    }
  }
  return true;
}

function commandOf(tool: string, input: unknown): string {
  return tool === 'Bash' && typeof input === 'object' && input !== null
    ? String((input as { command?: unknown }).command ?? '')
    : '';
}

export function checkToolUse(tool: string, input: unknown, ctx: PolicyContext): PolicyDecision {
  const command = commandOf(tool, input);
  const hits = RULES.filter((r) => r.tool === tool && r.pattern.test(command));
  if (hits.length === 0) return { allow: true };
  if (hits.every((r) => r.id === 'delete') && deletesOnlyInside(command, ctx))
    return { allow: true };
  const rule = hits[0] as Rule;
  return { allow: false, ruleId: rule.id, reason: rule.reason, command };
}
