import { type Query, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Job, Report, Usage, UsageWindow } from '@mai/protocol';
import { loadMemory, memoryPrompt } from './memory';
import { type DeskOutput, parseDeskOutput, visibleReply } from './parse';
import { ISOLATED, sdkEnv } from './sdk';

const SYSTEM_PROMPT = `You are the front desk of mai, a personal AI shell on the user's computer. The user types or dictates requests. You reply fast and hand real work to background workers.

Workers are Claude agents with shell, file and browser access on this machine. They run in the background and report back when done. For work in an existing project folder, set "cwd" to it; git projects get their own branch and are never pushed.

How to respond:
- Simple things (time, date, arithmetic, job status, questions about finished reports): answer yourself in one or two short sentences.
- Anything that needs the computer (files, shell, code, web research): reply with one short sentence saying what will happen, then end your message with a dispatch block, exactly like this:
<dispatch>[{"title": "short title", "prompt": "complete, self-contained instructions for the worker"}]</dispatch>
  Write the worker prompt so it can be done without asking anything; keep the user's exact names, paths and wording. Add "cwd": "/absolute/path" only when the user names an existing project folder. Use several entries only for clearly independent tasks.
- To stop jobs the user wants stopped, say so in one sentence and end with <cancel>["job id"]</cancel>, using ids from the job list.
- If the request is ambiguous in a way that changes the result, ask exactly one short question and do not dispatch.
- You cannot approve or deny a job's paused action; tell the user to use the approval card in the inbox.
- A message that says work will happen MUST end with the dispatch block; without the block nothing runs. This holds for repeats too ("again", "retry"): dispatch a new job each time.
- Never say work is done unless a report says so. You cannot use tools yourself.
- Answer only what was asked; do not bring up other jobs unless the user asks about them.
- Plain text, no markdown headings.

Each user message starts with a <context> block written by mai (not the user) with the local time, the job list and recent reports.`;

export interface DeskContext {
  now: Date;
  // Something the desk should mention if relevant, e.g. that new jobs are on hold.
  notice?: string;
  // The job the user is asking a follow-up about.
  about?: { job: Job; report?: Report; lines: string[] };
  jobs: Pick<Job, 'id' | 'title' | 'status'>[];
  reports: { jobId: string; title: string; summary: string; needs_you: string[] }[];
}

export type DeskResult = DeskOutput;

function aboutBlock({ job, report, lines }: NonNullable<DeskContext['about']>): string {
  return [
    `This message is a follow-up about job ${job.id} "${job.title}" [${job.status}].`,
    `Its folder: ${job.cwd}${job.branch ? ` (git worktree of ${job.project}, branch ${job.branch})` : ''}`,
    `Its instructions: ${job.spec.prompt}`,
    report ? `Its report: ${JSON.stringify(report)}` : 'No report yet.',
    `Its last steps:\n${lines.map((l) => `- ${l}`).join('\n') || '- none'}`,
    `For more work on it, dispatch with "cwd": "${job.cwd}".`,
  ].join('\n');
}

function contextBlock({ now, jobs, reports, about, notice }: DeskContext): string {
  const time = now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const jobLines = jobs.map((j) => `- ${j.id} [${j.status}] ${j.title}`).join('\n') || '- none';
  const reportLines =
    reports
      .map(
        (r) =>
          `- ${r.jobId} ${r.title}: ${r.summary}${r.needs_you.length ? ` (needs you: ${r.needs_you.join('; ')})` : ''}`,
      )
      .join('\n') || '- none';
  return `<context>\nLocal time: ${time} (${zone})\nJobs:\n${jobLines}\nRecent reports:\n${reportLines}${about ? `\n${aboutBlock(about)}` : ''}${notice ? `\nNote: ${notice}` : ''}\n</context>`;
}

interface Turn {
  text: string;
  onDelta: (visible: string) => void;
  resolve: (r: DeskResult) => void;
  reject: (e: Error) => void;
}

// One long-lived session: spawning Claude Code costs ~3-4 s, a warm turn ~1 s.
// Structured output is not used because it adds a second model round-trip (~4.5 s per turn).
export class FrontDesk {
  private q: Query | null = null;
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private current: Turn | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  // The memory text the running session was started with.
  private memoryText = '';

  constructor(
    private readonly config: () => {
      apiKeyMode: boolean;
      deskModel: string;
      contextDir: string | null;
    },
  ) {}

  private memoryNow(): string {
    const m = loadMemory(this.config().contextDir);
    return m ? memoryPrompt(m, 'desk') : '';
  }

  start(): void {
    if (this.q) return;
    this.memoryText = this.memoryNow();
    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = self.pending.shift();
        if (next) yield next;
        else await new Promise<void>((r) => (self.wake = r));
      }
    }
    const q = query({
      prompt: input(),
      options: {
        ...ISOLATED,
        model: this.config().deskModel,
        tools: [],
        settingSources: [],
        persistSession: false,
        thinking: { type: 'disabled' },
        effort: 'low',
        includePartialMessages: true,
        systemPrompt: SYSTEM_PROMPT + this.memoryText,
        env: sdkEnv(this.config().apiKeyMode),
      },
    });
    this.q = q;
    this.consume(q);
  }

  private async consume(q: Query): Promise<void> {
    let error: Error = new Error('front desk session ended');
    try {
      for await (const m of q) {
        const turn = this.current;
        if (!turn) continue;
        if (
          m.type === 'stream_event' &&
          m.parent_tool_use_id === null &&
          m.event.type === 'content_block_delta' &&
          m.event.delta.type === 'text_delta'
        ) {
          turn.text += m.event.delta.text;
          turn.onDelta(visibleReply(turn.text));
        } else if (m.type === 'result') {
          this.current = null;
          if (m.subtype === 'success' && !m.is_error) turn.resolve(parseDeskOutput(m.result));
          else turn.reject(new Error(m.subtype === 'success' ? m.result : m.subtype));
        }
      }
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }
    if (this.q === q) this.q = null;
    this.current?.reject(error);
    this.current = null;
  }

  turn(text: string, ctx: DeskContext, onDelta: (visible: string) => void): Promise<DeskResult> {
    const run = () =>
      new Promise<DeskResult>((resolve, reject) => {
        // Notes changed since this session started: begin a fresh one that knows them.
        if (this.q && this.memoryNow() !== this.memoryText) this.close();
        this.start();
        this.current = { text: '', onDelta, resolve, reject };
        this.pending.push({
          type: 'user',
          message: { role: 'user', content: `${contextBlock(ctx)}\n\n${text}` },
          parent_tool_use_id: null,
          origin: { kind: 'human' },
        });
        this.wake?.();
        this.wake = null;
      });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  // Rides on the warm desk session. The SDK marks this API experimental, so callers treat a
  // failure as "unknown" rather than an error.
  async usage(): Promise<Usage | null> {
    this.start();
    const r = await this.q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
      skipBehaviors: true,
    });
    if (!r?.rate_limits_available || !r.rate_limits) return null;
    const win = (w?: { utilization: number | null; resets_at: string | null } | null) =>
      w ? { pct: w.utilization, resetsAt: w.resets_at } : undefined;
    const fiveHour: UsageWindow | undefined = win(r.rate_limits.five_hour);
    const week: UsageWindow | undefined = win(r.rate_limits.seven_day);
    const extra = r.rate_limits.extra_usage;
    return {
      ...(fiveHour ? { fiveHour } : {}),
      ...(week ? { week } : {}),
      ...(extra?.is_enabled && extra.monthly_limit
        ? {
            credits: {
              used: extra.used_credits ?? 0,
              limit: extra.monthly_limit,
              currency: extra.currency ?? '',
            },
          }
        : {}),
      models: (r.rate_limits.model_scoped ?? []).map((m) => ({
        name: m.display_name,
        pct: m.utilization,
        resetsAt: m.resets_at,
      })),
      checkedAt: Date.now(),
    };
  }

  close(): void {
    this.q?.close();
    this.q = null;
  }
}
