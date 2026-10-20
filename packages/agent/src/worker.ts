import { type HookCallback, query } from '@anthropic-ai/claude-agent-sdk';
import type { JobSpec } from '@mai/protocol';
import { playwrightServer } from './browser';
import { loadMemory, memoryPrompt } from './memory';
import { checkToolUse } from './policy';
import { ISOLATED, sdkEnv } from './sdk';

export type WorkerEvent =
  | { kind: 'tool'; tool: string; summary: string }
  | { kind: 'text'; text: string };

export interface WorkerArgs {
  spec: JobSpec;
  cwd: string;
  model: string;
  home: string;
  apiKeyMode: boolean;
  headedBrowser: boolean;
  maxTurns: number;
  // 0 means no cap.
  maxCostUsd: number;
  // The job's own workspace folder; absent for plain (non-git) project folders.
  jobDir?: string;
  // Set when the job works in a git worktree made for it.
  git?: { project: string; branch: string };
  signal: AbortSignal;
  onEvent: (e: WorkerEvent) => void;
  // Resolves when the user decides; the worker session waits inside the hook meanwhile.
  requestApproval: (req: ApprovalRequest) => Promise<'approved' | 'denied'>;
  // The owner's notes folder, when memory is on.
  contextDir?: string;
  // Load the owner's claude.ai connectors (writes go through the approval policy).
  connectors?: boolean;
}

export interface ApprovalRequest {
  ruleId: string;
  reason: string;
  tool: string;
  command: string;
}

const WEEK_SECONDS = 7 * 24 * 3600;

export interface WorkerResult {
  ok: boolean;
  result: string;
  transcript: string;
}

const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'mcp__playwright',
];

const appendPrompt = ({
  home,
  jobDir,
  git,
  connectors,
}: Pick<WorkerArgs, 'home' | 'jobDir' | 'git' | 'connectors'>) => `
You are a mai worker: you run in the background for the user, who is not watching. Work on your own; nobody can answer questions mid-task. The user's home directory is ${home}.${jobDir ? `\nYour job folder is ${jobDir}. Deleting files inside it needs no approval if you use absolute paths without globs, quotes or variables.` : ''}${git ? `\nYou are in a git worktree of ${git.project}, on branch ${git.branch} made for this job. Commit your work on this branch with conventional commit messages. Never push and never switch branches; the user reviews the branch. The user's own checkout is untouched. If a commit fails (for example commit signing), never disable signing or hooks; leave the changes uncommitted and say so.` : ''}
For websites, use the browser tools (mcp__playwright__*): a fresh browser with no logins. Prefer it over WebFetch for shops and other dynamic pages. Read pages with browser_snapshot; browser_evaluate and browser_run_code_unsafe need the user's approval.
Deleting files elsewhere, sudo, git push/clean/reset --hard, and web actions that buy, send or submit something pause for the user's approval; the call simply waits until they decide.${connectors ? `\nYou can use the user's connected accounts (Gmail, Slack, Google Drive, Atlassian and others) through the mcp__claude_ai_* tools. Reading and searching are free; sending, replying, posting, creating, editing, deleting, labelling or sharing pauses for the user's approval.` : ''}
If the user denies a call, do not try to get around it; stop and say what you could not do.
If finishing really needs a decision from the user, stop and state exactly what you need in your final message.
End with a short plain summary of what you did and where the results are.`;

export function summarizeToolInput(input: unknown): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const pick =
    i.command ??
    i.file_path ??
    i.path ??
    i.pattern ??
    i.url ??
    i.query ??
    i.element ??
    i.description;
  const text = typeof pick === 'string' ? pick : JSON.stringify(input);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export function stoppedBecause(subtype: string, caps: Pick<WorkerArgs, 'maxTurns' | 'maxCostUsd'>) {
  if (subtype === 'error_max_turns') {
    return `stopped: reached the limit of ${caps.maxTurns} steps (change it in Settings)`;
  }
  if (subtype === 'error_max_budget_usd') {
    return `stopped: reached the cost cap of $${caps.maxCostUsd} (change it in Settings)`;
  }
  return `stopped: ${subtype.replace(/^error_/, '').replaceAll('_', ' ')}`;
}

export async function runWorker(args: WorkerArgs): Promise<WorkerResult> {
  const { spec, cwd, model, home, jobDir, git, apiKeyMode, signal, onEvent, requestApproval } =
    args;
  const memory = loadMemory(args.contextDir ?? null);
  const memoryText = memory ? memoryPrompt(memory, 'worker') : '';
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort(), { once: true });

  const policyHook: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const decision = checkToolUse(input.tool_name, input.tool_input, {
      home,
      jobDir,
      ...(args.contextDir ? { contextDir: args.contextDir } : {}),
    });
    if (decision.allow) return {};
    const { ruleId, reason, command } = decision;
    const answer = await requestApproval({ ruleId, reason, tool: input.tool_name, command });
    if (answer === 'approved') return {};
    const why = `The user denied this (${reason}): ${command}`;
    lines.push(`DENIED BY USER: ${command}`);
    return {
      continue: false,
      stopReason: why,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: why,
      },
    };
  };

  // The report writer only sees this transcript, so tell it what is by design.
  const lines = [
    `TASK: ${spec.prompt}`,
    git
      ? `SETUP: mai ran this job in ${cwd}, a git worktree of ${git.project} on new branch ${git.branch}; committing there is expected, pushing is not allowed.`
      : `SETUP: mai ran this job in ${cwd}.`,
  ];
  const q = query({
    prompt: spec.prompt,
    options: {
      ...ISOLATED,
      model,
      cwd,
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append:
          appendPrompt({
            home,
            jobDir,
            ...(git ? { git } : {}),
            ...(args.connectors ? { connectors: true } : {}),
          }) + memoryText,
      },
      mcpServers: { playwright: playwrightServer(jobDir ?? cwd, args.headedBrowser) },
      maxTurns: args.maxTurns,
      ...(args.maxCostUsd > 0 ? { maxBudgetUsd: args.maxCostUsd } : {}),
      ...(args.connectors
        ? {
            // The owner's claude.ai connectors load only without strict MCP config. Their tool
            // names vary per account, so everything the policy hook let through is allowed.
            strictMcpConfig: false,
            settings: {},
            permissionMode: 'default' as const,
            canUseTool: async (_tool: string, input: Record<string, unknown>) => ({
              behavior: 'allow' as const,
              updatedInput: input,
            }),
          }
        : { permissionMode: 'dontAsk' as const }),
      allowedTools: ALLOWED_TOOLS,
      // Jobs may read and write anywhere in ~ without approval (docs/DECISIONS.md 004).
      additionalDirectories: [home],
      settingSources: ['project'],
      hooks: { PreToolUse: [{ hooks: [policyHook], timeout: WEEK_SECONDS }] },
      env: sdkEnv(apiKeyMode),
    },
  });

  const done = (ok: boolean, result: string): WorkerResult => {
    lines.push(`RESULT (${ok ? 'ok' : 'error'}): ${result}`);
    return { ok, result, transcript: lines.join('\n') };
  };

  try {
    for await (const m of q) {
      if (m.type === 'assistant' && m.parent_tool_use_id === null) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            onEvent({ kind: 'text', text: block.text.trim() });
            lines.push(`ASSISTANT: ${block.text.trim()}`);
          } else if (block.type === 'tool_use') {
            const summary = summarizeToolInput(block.input);
            onEvent({
              kind: 'tool',
              tool: block.name.replace('mcp__playwright__browser_', 'browser '),
              summary,
            });
            lines.push(`TOOL ${block.name}: ${summary}`);
          }
        }
      } else if (
        m.type === 'user' &&
        m.parent_tool_use_id === null &&
        Array.isArray(m.message.content)
      ) {
        // Tool output goes only into the report transcript, so the report can say what happened
        // instead of guessing.
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue;
          const text =
            typeof block.content === 'string'
              ? block.content
              : (block.content ?? [])
                  .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
                  .join('\n');
          const clipped = text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
          lines.push(`OUTPUT${block.is_error ? ' (error)' : ''}: ${clipped}`);
        }
      } else if (m.type === 'result') {
        const ok = m.subtype === 'success' && !m.is_error;
        return done(ok, m.subtype === 'success' ? m.result : stoppedBecause(m.subtype, args));
      }
    }
    return done(false, signal.aborted ? 'cancelled' : 'worker ended without a result');
  } catch (e) {
    return done(false, signal.aborted ? 'cancelled' : e instanceof Error ? e.message : String(e));
  }
}
