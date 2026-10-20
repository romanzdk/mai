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

type Input = Record<string, unknown>;

interface Rule {
  id: string;
  tools: string[];
  reason: string;
  matches: (input: Input) => boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const bash = (id: string, pattern: RegExp, reason: string): Rule => ({
  id,
  tools: ['Bash'],
  reason,
  matches: (i) => pattern.test(str(i.command)),
});

const web = (name: string) => `mcp__playwright__browser_${name}`;

// What a page element is about to do, judged from the worker's own description of it. Czech
// stems too, since the owner's sites often are.
const RISKY_WEB_ACTION =
  /\b(buy|pay|purchase|checkout|check out|order|send|submit|post|publish|delete|remove|confirm|subscribe|sign up|transfer|donate|book|reserve)\b|koupi|objedn|zaplat|odesl|potvr|smaz/i;

const webTarget = (i: Input) =>
  [
    str(i.element),
    ...(Array.isArray(i.fields) ? i.fields.map((f: Input) => str(f?.name)) : []),
  ].join(' ');

// Matching is deliberately broad: a false positive costs one approval, a false negative can
// cost data. ponytail: regex screen over shell text and element descriptions, not a shell
// parser or page model; move to a real parser (or sandboxed execution) if workers start
// writing actions these miss.
const DELETE_PATTERN = /(^|[\s;&|(`])(rm|rmdir|unlink|shred|srm|trash)(\s|$)/;

export const RULES: Rule[] = [
  bash('sudo', /(^|[\s;&|(`])(sudo|doas|su)\s/, 'runs as root'),
  bash('delete', DELETE_PATTERN, 'deletes files'),
  bash('find-delete', /\bfind\b[^;&|]*\s-(delete|exec\s+rm)\b/, 'deletes files'),
  bash('git-push', /\bgit\s+push\b/, 'pushes to a remote'),
  bash('git-clean', /\bgit\s+clean\b/, 'deletes untracked files'),
  bash('git-reset-hard', /\bgit\s+reset\s+--hard\b/, 'discards uncommitted work'),
  bash('disk', /\b(mkfs|dd\s+if=|diskutil\s+erase)/, 'can wipe a disk'),
  {
    id: 'web-action',
    tools: ['click', 'type', 'fill_form', 'select_option', 'check'].map(web),
    reason: 'may buy, send or submit something on a website',
    // Submitting typed text sends it somewhere, unless it is clearly a search.
    matches: (i) =>
      RISKY_WEB_ACTION.test(webTarget(i)) ||
      (i.submit === true && !/search|hled|query|filter/i.test(str(i.element))),
  },
  {
    id: 'web-code',
    tools: ['evaluate', 'run_code_unsafe'].map(web),
    reason: 'runs code inside a web page',
    matches: () => true,
  },
  {
    id: 'web-upload',
    tools: [web('file_upload')],
    reason: 'uploads files from your computer to a website',
    matches: () => true,
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

// What the approval card shows: the exact shell command, or the web action and its target.
function describe(tool: string, i: Input): string {
  if (tool === 'Bash') return str(i.command);
  const name = tool.replace('mcp__playwright__browser_', 'browser ');
  const detail = [
    webTarget(i).trim(),
    str(i.text) && `text: ${str(i.text)}`,
    str(i.function) || str(i.code),
  ]
    .filter(Boolean)
    .join(' · ');
  return detail ? `${name}: ${detail}` : `${name}: ${JSON.stringify(i)}`;
}

export function checkToolUse(tool: string, input: unknown, ctx: PolicyContext): PolicyDecision {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Input;
  const hits = RULES.filter((r) => r.tools.includes(tool) && r.matches(i));
  if (hits.length === 0) return { allow: true };
  const command = describe(tool, i);
  if (hits.every((r) => r.id === 'delete') && deletesOnlyInside(command, ctx))
    return { allow: true };
  const rule = hits[0] as Rule;
  return { allow: false, ruleId: rule.id, reason: rule.reason, command };
}
