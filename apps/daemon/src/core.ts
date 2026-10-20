import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Agent, WORKER_MODEL } from '@mai/agent';
import {
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

const isDir = (path: string) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;

export class Core {
  private listeners = new Set<(msg: ServerMessage) => void>();
  private running = new Map<string, AbortController>();

  constructor(private readonly opts: CoreOptions) {
    // A job that was running when the daemon stopped has no live worker any more.
    for (const job of opts.store.jobs('running')) {
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
    const terminal = status === 'done' || status === 'failed' || status === 'cancelled';
    this.opts.store.setJobStatus(jobId, status, terminal ? Date.now() : null);
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
      for (const job of jobs) this.record(job.id, { kind: 'job_created', job });
      this.schedule();
    } catch (e) {
      this.record(null, {
        kind: 'desk_error',
        message: e instanceof Error ? e.message : String(e),
        inputId,
      });
    }
  }

  private createJob(spec: JobSpec): Job {
    const id = randomUUID().slice(0, 8);
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

  private async run(job: Job): Promise<void> {
    const abort = new AbortController();
    this.running.set(job.id, abort);
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
        signal: abort.signal,
        onEvent: (e) =>
          this.record(
            job.id,
            e.kind === 'tool'
              ? { kind: 'job_tool', tool: e.tool, summary: e.summary }
              : { kind: 'job_text', text: e.text },
          ),
      });
      const report = await this.opts.agent.summarize(result.transcript).catch((e: unknown) => ({
        summary: result.result,
        changes: [],
        artifacts: [],
        needs_you: [
          `The report step failed (${e instanceof Error ? e.message : e}); this is the worker's own summary.`,
        ],
      }));
      this.opts.store.saveReport(job.id, report);
      this.record(job.id, { kind: 'job_report', report });
      this.setStatus(job.id, result.ok ? 'done' : 'failed', result.ok ? undefined : result.result);
    } catch (e) {
      this.setStatus(job.id, 'failed', e instanceof Error ? e.message : String(e));
    } finally {
      this.running.delete(job.id);
      this.schedule();
    }
  }

  shutdown(): void {
    for (const abort of this.running.values()) abort.abort();
    this.opts.agent.close();
  }
}
