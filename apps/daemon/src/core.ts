import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import type { Agent, ApprovalRequest } from '@mai/agent';
import {
  type AuthState,
  applySettings,
  DEFAULT_SETTINGS,
  type EventBody,
  type Job,
  type JobSpec,
  type JobStatus,
  PROTOCOL_VERSION,
  REMEMBERABLE_RULES,
  type ServerMessage,
  type Settings,
  type Usage,
  type UsageWindow,
} from '@mai/protocol';
import type { Store } from './store';

export interface CoreOptions {
  store: Store;
  agent: Agent;
  home: string;
  // Starting values; settings saved from the UI win over them.
  settings?: Settings;
  workspace?: string;
  maxParallel?: number;
}

interface RunState {
  abort: AbortController;
  cancelled: boolean;
  denied?: string;
  timedOut?: boolean;
  lastActivity: number;
}

const IDLE_CHECK_MS = 15_000;

const hhmm = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : '';

interface PendingApproval {
  jobId: string;
  ruleId: string;
  rememberKey: string;
  command: string;
  resolve: (answer: 'approved' | 'denied') => void;
}

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];
const LOGIN_POLL_MS = 3000;
const WORKTREE_SWEEP_MS = 10 * 60_000;
const USAGE_POLL_MS = 5 * 60_000;
const USAGE_MIN_GAP_MS = 30_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const openWithSystem = (target: string) =>
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], {
    stdio: 'ignore',
    detached: true,
  }).unref();
const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const run = promisify(execFile);

function isGitRepo(dir: string): boolean {
  if (!isDir(dir)) return false;
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const shortId = () => randomUUID().slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Core {
  private listeners = new Set<(msg: ServerMessage) => void>();
  private running = new Map<string, RunState>();
  private pending = new Map<string, PendingApproval>();
  // "Remember" lasts until the daemon restarts: same rule, same job, remembered rules only.
  private remembered = new Set<string>();
  private auth: { state: AuthState; detail?: string } = { state: 'checking' };
  private loginTimer?: ReturnType<typeof setInterval>;
  private sweepTimer: ReturnType<typeof setInterval>;
  private usageTimer: ReturnType<typeof setInterval>;
  private usageState: Usage | null = null;
  private usageCheckedAt = 0;
  private settingsState: Settings;
  // "Run anyway": the plan-limit pause is lifted until this time.
  private pauseOverrideUntil = 0;
  private lastPaused: string | null = null;

  constructor(private readonly opts: CoreOptions) {
    const { store } = opts;
    const initial = opts.settings ?? {
      ...DEFAULT_SETTINGS,
      workspace: opts.workspace ?? join(opts.home, 'mai'),
      maxParallel: opts.maxParallel ?? DEFAULT_SETTINGS.maxParallel,
    };
    this.settingsState = applySettings(initial, store.getSettings());
    // Nothing that was in flight when the daemon stopped has a live worker any more.
    for (const approval of store.pendingApprovals()) {
      store.decideApproval(approval.id, 'expired');
      this.record(approval.jobId, {
        kind: 'approval_decided',
        approvalId: approval.id,
        decision: 'expired',
        by: 'restart',
      });
    }
    for (const job of [...store.jobs('running'), ...store.jobs('waiting_approval')]) {
      this.setStatus(
        job.id,
        'failed',
        'interrupted: the daemon stopped while this job was running',
      );
    }
    this.schedule();
    void this.sweepMergedWorktrees();
    this.sweepTimer = setInterval(() => void this.sweepMergedWorktrees(), WORKTREE_SWEEP_MS);
    this.sweepTimer.unref();
    this.usageTimer = setInterval(() => void this.refreshUsage(true), USAGE_POLL_MS);
    this.usageTimer.unref();
  }

  get usage(): Usage | null {
    return this.usageState;
  }

  // Polled, and refreshed after each job; at most every 30 s unless forced by the timer.
  async refreshUsage(force = false): Promise<void> {
    if (!force && Date.now() - this.usageCheckedAt < USAGE_MIN_GAP_MS) return;
    this.usageCheckedAt = Date.now();
    try {
      this.usageState = await this.opts.agent.usage();
    } catch {
      return;
    }
    this.broadcast({ v: PROTOCOL_VERSION, type: 'usage', usage: this.usageState });
    this.schedule();
  }

  get settings(): Settings {
    return this.settingsState;
  }

  updateSettings(patch: unknown): void {
    const prev = this.settingsState;
    const next = applySettings(prev, patch);
    this.settingsState = next;
    this.opts.store.saveSettings(next);
    this.broadcast({ v: PROTOCOL_VERSION, type: 'settings', settings: next });
    if (prev.deskModel !== next.deskModel || prev.apiKeyMode !== next.apiKeyMode) {
      this.opts.agent.reconfigure();
    }
    if (prev.apiKeyMode !== next.apiKeyMode) {
      void this.checkAuth().then(() => this.refreshUsage(true));
    }
    this.schedule();
  }

  // The plan window that is at or over the pause threshold, if any.
  private blockingWindow(): { name: string; w: UsageWindow } | undefined {
    const limit = this.settingsState.pauseAtUsagePct;
    if (limit >= 100 || Date.now() < this.pauseOverrideUntil || !this.usageState) return undefined;
    const windows = [
      { name: 'the 5-hour limit', w: this.usageState.fiveHour },
      { name: 'the weekly limit', w: this.usageState.week },
    ];
    return windows.find((x): x is { name: string; w: UsageWindow } =>
      Boolean(x.w && x.w.pct !== null && x.w.pct >= limit),
    );
  }

  get paused(): string | null {
    const b = this.blockingWindow();
    if (!b) return null;
    const resets = hhmm(b.w.resetsAt);
    return `${b.name} is at ${b.w.pct}%${resets ? ` (resets ${resets})` : ''}`;
  }

  resumeAnyway(): void {
    const b = this.blockingWindow();
    if (!b) return;
    const until = b.w.resetsAt ? Date.parse(b.w.resetsAt) : Number.NaN;
    this.pauseOverrideUntil = Number.isFinite(until) ? until : Date.now() + 3600_000;
    this.schedule();
  }

  get store(): Store {
    return this.opts.store;
  }

  get home(): string {
    return this.opts.home;
  }

  get authState() {
    return this.auth;
  }

  subscribe(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(msg: ServerMessage): void {
    for (const fn of this.listeners) fn(msg);
  }

  private record(jobId: string | null, body: EventBody): void {
    const event = this.opts.store.appendEvent(jobId, body);
    this.broadcast({ v: PROTOCOL_VERSION, type: 'event', event });
  }

  private setStatus(jobId: string, status: JobStatus, error?: string): void {
    this.opts.store.setJobStatus(jobId, status, TERMINAL.includes(status) ? Date.now() : null);
    this.record(jobId, { kind: 'job_status', status, ...(error ? { error } : {}) });
  }

  async handleInput(inputId: string, text: string, aboutJobId?: string): Promise<void> {
    const { store } = this.opts;
    const about = aboutJobId ? store.job(aboutJobId) : undefined;
    this.record(about?.id ?? null, {
      kind: 'user_input',
      text,
      inputId,
      ...(about ? { aboutJobId: about.id } : {}),
    });
    const ctx = {
      now: new Date(),
      ...(about ? { about: this.aboutContext(about) } : {}),
      ...(this.paused
        ? { notice: `New jobs are on hold because ${this.paused}; they wait in the queue.` }
        : {}),
      jobs: store.jobs(undefined, 20),
      reports: store.recentReports(5).map((r) => ({
        jobId: r.jobId,
        title: r.title,
        summary: r.report.summary,
        needs_you: r.report.needs_you,
      })),
    };
    try {
      const out = await this.opts.agent.desk(text, ctx, (visible) =>
        this.broadcast({ v: PROTOCOL_VERSION, type: 'desk_delta', inputId, text: visible }),
      );
      const jobs = out.jobs.map((spec) => this.createJob(spec));
      this.record(null, {
        kind: 'desk_reply',
        text: out.reply,
        inputId,
        jobIds: jobs.map((j) => j.id),
      });
      if (out.error) this.record(null, { kind: 'desk_error', message: out.error, inputId });
      for (const id of out.cancel) {
        if (!this.cancel(id)) {
          this.record(null, {
            kind: 'desk_error',
            message: `no active job ${id} to cancel`,
            inputId,
          });
        }
      }
      for (const job of jobs) this.record(job.id, { kind: 'job_created', job });
      this.schedule();
    } catch (e) {
      this.record(null, { kind: 'desk_error', message: message(e), inputId });
    }
  }

  private aboutContext(job: Job) {
    const { store } = this.opts;
    const report = store.report(job.id);
    const lines = store.jobEvents(job.id).flatMap((e) => {
      if (e.kind === 'job_tool') return [`${e.tool}: ${e.summary}`];
      if (e.kind === 'job_text') return [e.text.slice(0, 500)];
      return [];
    });
    return { job, ...(report ? { report } : {}), lines: lines.slice(-15) };
  }

  private createJob(spec: JobSpec): Job {
    const id = shortId();
    const jobDir = join(this.settingsState.workspace, 'jobs', id);
    // A git project gets its own worktree and branch, so the user's checkout is never touched
    // and jobs on the same repo can run side by side.
    const git =
      spec.cwd && isGitRepo(spec.cwd)
        ? { project: spec.cwd, branch: `mai/${id}`, cwd: join(jobDir, basename(spec.cwd)) }
        : undefined;
    const job: Job = {
      id,
      title: spec.title,
      spec,
      status: 'queued',
      model: spec.model ?? this.settingsState.workerModel,
      cwd: git?.cwd ?? spec.cwd ?? jobDir,
      createdAt: Date.now(),
      finishedAt: null,
      ...(git ? { project: git.project, branch: git.branch } : {}),
    };
    this.opts.store.insertJob(job);
    return job;
  }

  private schedule(): void {
    const paused = this.paused;
    if (paused !== this.lastPaused) {
      this.lastPaused = paused;
      this.broadcast({ v: PROTOCOL_VERSION, type: 'scheduler', paused });
    }
    if (paused) return;
    const free = this.settingsState.maxParallel - this.running.size;
    if (free <= 0) return;
    for (const job of this.opts.store.jobs('queued', free)) void this.run(job);
  }

  private requestApproval(job: Job, req: ApprovalRequest): Promise<'approved' | 'denied'> {
    const approvalId = shortId();
    const rememberKey = `${req.ruleId}|${job.id}`;
    this.opts.store.insertApproval({ id: approvalId, jobId: job.id, ...req });
    this.record(job.id, { kind: 'approval_requested', approvalId, ...req });
    const answer = new Promise<'approved' | 'denied'>((resolve) =>
      this.pending.set(approvalId, {
        jobId: job.id,
        ruleId: req.ruleId,
        rememberKey,
        command: req.command,
        resolve,
      }),
    );
    if (this.remembered.has(rememberKey)) this.decide(approvalId, 'approved', 'remembered');
    else this.setStatus(job.id, 'waiting_approval');
    return answer;
  }

  decide(
    approvalId: string,
    decision: 'approved' | 'denied',
    by: 'you' | 'remembered' | 'cancel',
    remember = false,
  ): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    this.pending.delete(approvalId);
    // The UI only offers "remember" for these rules; enforce it here too.
    const remembers = remember && REMEMBERABLE_RULES.includes(p.ruleId);
    this.opts.store.decideApproval(approvalId, decision);
    this.record(p.jobId, {
      kind: 'approval_decided',
      approvalId,
      decision,
      by,
      ...(remembers ? { remember: true } : {}),
    });
    const state = this.running.get(p.jobId);
    if (decision === 'approved' && remembers) this.remembered.add(p.rememberKey);
    if (decision === 'denied' && by === 'you' && state) state.denied = p.command;
    const stillWaiting = [...this.pending.values()].some((x) => x.jobId === p.jobId);
    if (decision === 'approved' && by === 'you' && !stillWaiting && !state?.cancelled) {
      this.setStatus(p.jobId, 'running');
    }
    p.resolve(decision);
    return true;
  }

  cancel(jobId: string): boolean {
    const job = this.opts.store.job(jobId);
    if (!job || TERMINAL.includes(job.status)) return false;
    const state = this.running.get(jobId);
    if (!state) {
      this.setStatus(jobId, 'cancelled', 'cancelled by you');
      return true;
    }
    state.cancelled = true;
    for (const [id, p] of this.pending) if (p.jobId === jobId) this.decide(id, 'denied', 'cancel');
    state.abort.abort();
    return true;
  }

  retry(jobId: string): boolean {
    const old = this.opts.store.job(jobId);
    if (!old || !TERMINAL.includes(old.status)) return false;
    const job = this.createJob(old.spec);
    this.record(job.id, { kind: 'job_created', job, retryOf: old.id });
    this.schedule();
    return true;
  }

  dismiss(jobId: string): Promise<void> {
    const job = this.opts.store.job(jobId);
    if (!job) return Promise.resolve();
    this.record(jobId, { kind: 'inbox_dismissed' });
    return this.removeWorktree(job, 'dismissed', true);
  }

  // Only the worktree goes; the branch is the job's result and stays for the user. Never
  // forced: git refuses when the worktree has uncommitted changes, and then it is kept.
  private async removeWorktree(job: Job, why: string, reportFailure: boolean): Promise<void> {
    if (!job.project || !job.branch || !TERMINAL.includes(job.status) || !isDir(job.cwd)) return;
    try {
      await run('git', ['-C', job.project, 'worktree', 'remove', job.cwd]);
      this.record(job.id, {
        kind: 'job_text',
        text: `Removed the worktree ${job.cwd} (${why}); branch ${job.branch} is kept.`,
      });
    } catch (e) {
      if (!reportFailure) return;
      const detail = (e as { stderr?: string }).stderr?.trim() || message(e);
      this.record(job.id, { kind: 'job_text', text: `Kept the worktree ${job.cwd}: ${detail}` });
    }
  }

  async sweepMergedWorktrees(): Promise<void> {
    for (const job of this.opts.store.gitJobs()) {
      if (!job.project || !job.branch || !TERMINAL.includes(job.status) || !isDir(job.cwd))
        continue;
      const merged = await run('git', [
        '-C',
        job.project,
        'merge-base',
        '--is-ancestor',
        job.branch,
        'HEAD',
      ]).then(
        () => true,
        () => false,
      );
      if (merged) await this.removeWorktree(job, `branch merged into ${job.project}`, false);
    }
  }

  openFolder(jobId: string): void {
    const job = this.opts.store.job(jobId);
    if (job && isDir(job.cwd)) openWithSystem(job.cwd);
  }

  // Only what the job's own report lists as an artifact, so the UI cannot be used to open
  // arbitrary files or URLs.
  openPath(jobId: string, path: string): boolean {
    const artifacts = this.opts.store.report(jobId)?.artifacts ?? [];
    if (!artifacts.includes(path)) return false;
    if (/^https?:\/\//.test(path) || statSync(path, { throwIfNoEntry: false })) {
      openWithSystem(path);
      return true;
    }
    return false;
  }

  private setAuth(state: AuthState, detail?: string): void {
    this.auth = { state, ...(detail ? { detail } : {}) };
    this.broadcast({ v: PROTOCOL_VERSION, type: 'auth', ...this.auth });
  }

  async checkAuth(): Promise<AuthState> {
    try {
      const state = await this.opts.agent.authState();
      if (state !== 'logged_out' || this.auth.state !== 'login_started') this.setAuth(state);
      return state;
    } catch (e) {
      this.setAuth('logged_out', `could not check the Claude login: ${message(e)}`);
      return 'logged_out';
    }
  }

  login(): void {
    if (this.auth.state === 'logged_in' || this.auth.state === 'api_key') return;
    try {
      this.opts.agent.openLogin();
    } catch (e) {
      this.setAuth('logged_out', `could not open a terminal: ${message(e)}`);
      return;
    }
    this.setAuth('login_started');
    clearInterval(this.loginTimer);
    const started = Date.now();
    this.loginTimer = setInterval(async () => {
      const state = await this.checkAuth();
      if (state === 'logged_in' || Date.now() - started > LOGIN_TIMEOUT_MS) {
        clearInterval(this.loginTimer);
        if (state !== 'logged_in') this.setAuth('logged_out', 'login timed out');
      }
    }, LOGIN_POLL_MS);
  }

  private async run(job: Job): Promise<void> {
    const state: RunState = {
      abort: new AbortController(),
      cancelled: false,
      lastActivity: Date.now(),
    };
    this.running.set(job.id, state);
    this.setStatus(job.id, 'running');
    // A job waiting for the user is not hung; only time without new steps counts.
    const idle = setInterval(() => {
      const waiting = [...this.pending.values()].some((p) => p.jobId === job.id);
      if (waiting) state.lastActivity = Date.now();
      const limit = this.settingsState.jobIdleMinutes * 60_000;
      if (Date.now() - state.lastActivity > limit && !state.cancelled) {
        state.timedOut = true;
        state.abort.abort();
      }
    }, IDLE_CHECK_MS);
    try {
      const jobDir = join(this.settingsState.workspace, 'jobs', job.id);
      if (job.project && job.branch) {
        mkdirSync(jobDir, { recursive: true });
        await run('git', [
          '-C',
          job.project,
          'worktree',
          'add',
          '-b',
          job.branch,
          job.cwd,
          'HEAD',
        ]).catch((e: { stderr?: string }) => {
          throw new Error(`could not create a git worktree: ${e.stderr?.trim() || message(e)}`);
        });
      } else if (job.spec.cwd) {
        if (!isDir(job.cwd)) throw new Error(`project folder does not exist: ${job.cwd}`);
      } else {
        mkdirSync(job.cwd, { recursive: true });
      }
      const result = await this.opts.agent.runWorker({
        spec: job.spec,
        cwd: job.cwd,
        model: job.model,
        home: this.opts.home,
        ...(job.spec.cwd && !job.branch ? {} : { jobDir }),
        ...(job.project && job.branch ? { git: { project: job.project, branch: job.branch } } : {}),
        signal: state.abort.signal,
        maxTurns: this.settingsState.jobMaxTurns,
        maxCostUsd: this.settingsState.jobMaxCostUsd,
        onEvent: (e) => {
          state.lastActivity = Date.now();
          this.record(
            job.id,
            e.kind === 'tool'
              ? { kind: 'job_tool', tool: e.tool, summary: e.summary }
              : { kind: 'job_text', text: e.text },
          );
        },
        requestApproval: (req) => this.requestApproval(job, req),
      });
      if (state.cancelled) {
        this.setStatus(job.id, 'cancelled', 'cancelled by you');
        return;
      }
      const report = await this.opts.agent.summarize(result.transcript).catch((e: unknown) => ({
        summary: result.result,
        changes: [],
        artifacts: [],
        needs_you: [`The report step failed (${message(e)}); this is the worker's own summary.`],
      }));
      this.opts.store.saveReport(job.id, report);
      this.record(job.id, { kind: 'job_report', report });
      if (state.timedOut) {
        const minutes = this.settingsState.jobIdleMinutes;
        this.setStatus(job.id, 'failed', `stopped: no activity for ${minutes} minutes`);
      } else if (state.denied) this.setStatus(job.id, 'failed', `you denied: ${state.denied}`);
      else
        this.setStatus(
          job.id,
          result.ok ? 'done' : 'failed',
          result.ok ? undefined : result.result,
        );
    } catch (e) {
      this.setStatus(job.id, state.cancelled ? 'cancelled' : 'failed', message(e));
    } finally {
      clearInterval(idle);
      this.running.delete(job.id);
      this.schedule();
      void this.refreshUsage();
    }
  }

  shutdown(): void {
    clearInterval(this.loginTimer);
    clearInterval(this.sweepTimer);
    clearInterval(this.usageTimer);
    for (const state of this.running.values()) state.abort.abort();
    this.opts.agent.close();
  }
}
