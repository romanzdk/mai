import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Agent, type ApprovalRequest, WORKER_MODEL } from '@mai/agent';
import {
  type AuthState,
  type EventBody,
  type Job,
  type JobSpec,
  type JobStatus,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mai/protocol';
import type { Store } from './store';

export interface CoreOptions {
  store: Store;
  agent: Agent;
  workspace: string;
  home: string;
  maxParallel: number;
}

interface RunState {
  abort: AbortController;
  cancelled: boolean;
  denied?: string;
}

interface PendingApproval {
  jobId: string;
  rememberKey: string;
  command: string;
  resolve: (answer: 'approved' | 'denied') => void;
}

const TERMINAL: JobStatus[] = ['done', 'failed', 'cancelled'];
const LOGIN_POLL_MS = 3000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
const shortId = () => randomUUID().slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Core {
  private listeners = new Set<(msg: ServerMessage) => void>();
  private running = new Map<string, RunState>();
  private pending = new Map<string, PendingApproval>();
  // "Remember" lasts until the daemon restarts: same rule, same job folder.
  private remembered = new Set<string>();
  private auth: { state: AuthState; detail?: string } = { state: 'checking' };
  private loginTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly opts: CoreOptions) {
    const { store } = opts;
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
  }

  get store(): Store {
    return this.opts.store;
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

  async handleInput(inputId: string, text: string): Promise<void> {
    this.record(null, { kind: 'user_input', text, inputId });
    const { store } = this.opts;
    const ctx = {
      now: new Date(),
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

  private createJob(spec: JobSpec): Job {
    const id = shortId();
    const job: Job = {
      id,
      title: spec.title,
      spec,
      status: 'queued',
      model: spec.model ?? WORKER_MODEL,
      cwd: spec.cwd ?? join(this.opts.workspace, 'jobs', id),
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.opts.store.insertJob(job);
    return job;
  }

  private schedule(): void {
    const free = this.opts.maxParallel - this.running.size;
    if (free <= 0) return;
    for (const job of this.opts.store.jobs('queued', free)) void this.run(job);
  }

  private requestApproval(job: Job, req: ApprovalRequest): Promise<'approved' | 'denied'> {
    const approvalId = shortId();
    const rememberKey = `${req.ruleId}|${job.cwd}`;
    this.opts.store.insertApproval({ id: approvalId, jobId: job.id, ...req });
    this.record(job.id, { kind: 'approval_requested', approvalId, ...req });
    const answer = new Promise<'approved' | 'denied'>((resolve) =>
      this.pending.set(approvalId, { jobId: job.id, rememberKey, command: req.command, resolve }),
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
    this.opts.store.decideApproval(approvalId, decision);
    this.record(p.jobId, {
      kind: 'approval_decided',
      approvalId,
      decision,
      by,
      ...(remember ? { remember } : {}),
    });
    const state = this.running.get(p.jobId);
    if (decision === 'approved' && remember) this.remembered.add(p.rememberKey);
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

  dismiss(jobId: string): void {
    if (this.opts.store.job(jobId)) this.record(jobId, { kind: 'inbox_dismissed' });
  }

  openFolder(jobId: string): void {
    const job = this.opts.store.job(jobId);
    if (!job || !isDir(job.cwd)) return;
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [job.cwd], { stdio: 'ignore', detached: true }).unref();
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
    const state: RunState = { abort: new AbortController(), cancelled: false };
    this.running.set(job.id, state);
    this.setStatus(job.id, 'running');
    try {
      if (job.spec.cwd) {
        if (!isDir(job.cwd)) throw new Error(`project folder does not exist: ${job.cwd}`);
      } else {
        mkdirSync(job.cwd, { recursive: true });
      }
      const result = await this.opts.agent.runWorker({
        spec: job.spec,
        cwd: job.cwd,
        model: job.model,
        home: this.opts.home,
        ...(job.spec.cwd ? {} : { jobDir: job.cwd }),
        signal: state.abort.signal,
        onEvent: (e) =>
          this.record(
            job.id,
            e.kind === 'tool'
              ? { kind: 'job_tool', tool: e.tool, summary: e.summary }
              : { kind: 'job_text', text: e.text },
          ),
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
      if (state.denied) this.setStatus(job.id, 'failed', `you denied: ${state.denied}`);
      else
        this.setStatus(
          job.id,
          result.ok ? 'done' : 'failed',
          result.ok ? undefined : result.result,
        );
    } catch (e) {
      this.setStatus(job.id, state.cancelled ? 'cancelled' : 'failed', message(e));
    } finally {
      this.running.delete(job.id);
      this.schedule();
    }
  }

  shutdown(): void {
    clearInterval(this.loginTimer);
    for (const state of this.running.values()) state.abort.abort();
    this.opts.agent.close();
  }
}
