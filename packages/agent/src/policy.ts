import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export type PolicyDecision =
  | { allow: true }
  | { allow: false; ruleId: string; reason: string; command: string };

export interface PolicyContext {
  home: string;
  // Deletes strictly inside this folder need no approval (docs/DECISIONS.md 004).
  jobDir?: string;
  // The owner's notes folder: only appends to its inbox and decisions files are free.
  contextDir?: string;
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

const APPEND_ONLY = ['inbox.md', 'decisions.md'];
const CONTEXT_REASON = 'changes your ~/context notes';

const inside = (path: string, dir: string) => {
  const real = realPath(resolve(path));
  const root = realPath(dir);
  return real === root || real.startsWith(root + sep);
};

// An Edit whose old text is the unique end of the file and whose new text starts with it.
function isPureAppend(path: string, i: Input): boolean {
  if (i.replace_all === true) return false;
  const old = str(i.old_string);
  const next = str(i.new_string);
  if (!old || !next.startsWith(old)) return false;
  try {
    const content = readFileSync(path, 'utf8');
    return (
      content.trimEnd().endsWith(old.trimEnd()) && content.indexOf(old) === content.lastIndexOf(old)
    );
  } catch {
    return false;
  }
}

const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function contextFileChange(tool: string, i: Input, ctx: PolicyContext): boolean {
  const dir = ctx.contextDir;
  if (!dir || !WRITE_TOOLS.includes(tool)) return false;
  const file = str(i.file_path) || str(i.notebook_path);
  if (!file || !inside(file, dir)) return false;
  const appendOnly = APPEND_ONLY.some(
    (name) => realPath(resolve(file)) === realPath(join(dir, name)),
  );
  return !(tool === 'Edit' && appendOnly && isPureAppend(file, i));
}

// ponytail: regex screen over the shell text; a determined script (python -c, a heredoc into
// another tool) can still write there. Move to sandboxed execution if that ever matters.
function contextShellChange(command: string, ctx: PolicyContext): boolean {
  const dir = ctx.contextDir;
  if (!dir) return false;
  const spellings = [dir];
  if (dir.startsWith(`${ctx.home}/`)) {
    const rest = dir.slice(ctx.home.length);
    spellings.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`);
  }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const path = `["']?(?:${spellings.map(esc).join('|')})(?:/[^\\s"';|&)]*)?["']?`;
  if (!new RegExp(path).test(command)) return false;
  const appendTo = new RegExp(
    `>>\\s*["']?(?:${spellings.map(esc).join('|')})/([^\\s"';|&)]+)`,
    'g',
  );
  const overwrite = new RegExp(`(^|[^>])>\\s*${path}`);
  if (overwrite.test(command)) return true;
  for (const m of command.matchAll(appendTo)) {
    if (!APPEND_ONLY.includes(m[1] ?? '')) return true;
  }
  const writer =
    /(^|[\s;&|(`])(sed\s+[^|;&]*-i|tee|mv|cp|ln|touch|mkdir|truncate|rsync|install|chmod|chown|git|perl\s+[^|;&]*-i)(\s|$)/;
  return writer.test(command);
}

// What the approval card shows for a notes change: the file and the text going in or out.
function describeFileChange(tool: string, i: Input): string {
  const clip = (t: string) => (t.length > 400 ? `${t.slice(0, 400)}…` : t);
  const lines = (prefix: string, t: string) =>
    clip(t)
      .split('\n')
      .map((l) => `${prefix} ${l}`)
      .join('\n');
  const path = str(i.file_path) || str(i.notebook_path);
  if (tool === 'Edit') {
    return `Edit ${path}\n${lines('-', str(i.old_string))}\n${lines('+', str(i.new_string))}`;
  }
  if (tool === 'Write') return `Write ${path}\n${lines('+', str(i.content))}`;
  return `${tool} ${path}`;
}

// claude.ai connector tools are free only when their action reads; everything else (send,
// reply, create, edit, delete, share, label, drafts, …) asks. Unknown verbs ask too.
const CONNECTOR_READ =
  /^(get|list|search|read|fetch|query|lookup|guide|download|export|atlassianUserInfo)/i;

function mcpDecision(tool: string, i: Input): PolicyDecision | undefined {
  const [prefix, server = '', action = ''] = tool.split('__');
  if (prefix !== 'mcp' || server === 'playwright') return undefined;
  const command = `${server.replace(/^claude_ai_/, '').replaceAll('_', ' ')} ${action}: ${clipJson(i)}`;
  if (!server.startsWith('claude_ai_')) {
    return {
      allow: false,
      ruleId: 'mcp-other',
      reason: `uses a tool from the ${server} MCP server`,
      command,
    };
  }
  if (CONNECTOR_READ.test(action.replace(/^slack_/, ''))) return { allow: true };
  return {
    allow: false,
    ruleId: 'connector-write',
    reason: 'sends, changes or shares something in your connected accounts',
    command,
  };
}

const clipJson = (i: Input) => {
  const text = JSON.stringify(i);
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
};

export function checkToolUse(tool: string, input: unknown, ctx: PolicyContext): PolicyDecision {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Input;
  const mcp = mcpDecision(tool, i);
  if (mcp) return mcp;
  if (
    contextFileChange(tool, i, ctx) ||
    (tool === 'Bash' && contextShellChange(str(i.command), ctx))
  ) {
    const command = tool === 'Bash' ? str(i.command) : describeFileChange(tool, i);
    return { allow: false, ruleId: 'context-write', reason: CONTEXT_REASON, command };
  }
  const hits = RULES.filter((r) => r.tools.includes(tool) && r.matches(i));
  if (hits.length === 0) return { allow: true };
  const command = describe(tool, i);
  if (hits.every((r) => r.id === 'delete') && deletesOnlyInside(command, ctx))
    return { allow: true };
  const rule = hits[0] as Rule;
  return { allow: false, ruleId: rule.id, reason: rule.reason, command };
}
