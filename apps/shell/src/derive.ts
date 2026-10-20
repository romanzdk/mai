import type { Job, JobStatus, MaiEvent, Report } from '@mai/protocol';

export type ApprovalEvent = Extract<MaiEvent, { kind: 'approval_requested' }>;

export interface JobState {
  job: Job;
  status: JobStatus;
  error?: string;
  timeline: MaiEvent[];
  report?: Report;
  retryOf?: string;
  pendingApprovals: ApprovalEvent[];
  // Every approval this job asked for, so decisions can show their command.
  requested: Record<string, ApprovalEvent>;
  dismissed: boolean;
  lastTs: number;
  finishedAt?: number;
}

export interface Exchange {
  inputId: string;
  text: string;
  ts: number;
  reply?: string;
  error?: string;
  jobIds: string[];
  scheduleIds?: string[];
  aboutJobId?: string;
}

export const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_input'];
export const isActive = (j: JobState) => ACTIVE.includes(j.status);

// Finished jobs the user still has to look at: open questions in the report, or a failure
// they did not cause themselves.
export function needsAttention(j: JobState): boolean {
  if (isActive(j) || j.dismissed) return false;
  // A scheduled run's report is the point of the schedule: show it until read.
  if (j.job.scheduleId && j.status === 'done') return true;
  if ((j.report?.needs_you.length ?? 0) > 0) return true;
  return j.status === 'failed' && !j.error?.startsWith('you denied');
}

export function statusLabel(j: JobState): string {
  if (j.status === 'waiting_approval' || j.status === 'waiting_input') return 'needs you';
  if (j.status === 'done' && j.job.scheduleId && !j.dismissed && !j.report?.needs_you.length) {
    return 'new report';
  }
  if (j.status === 'done' && needsAttention(j)) return 'needs you';
  return j.status;
}

export function timelineLine(e: MaiEvent, requested: Record<string, ApprovalEvent> = {}): string {
  switch (e.kind) {
    case 'job_tool':
      return `${e.tool} ${e.summary}`;
    case 'job_text':
      return e.text.split('\n')[0] ?? '';
    case 'job_status': {
      const status = e.status.replace('_', ' ');
      return e.error ? `${status}: ${e.error}` : status;
    }
    case 'job_report':
      return e.report.summary;
    case 'approval_requested':
      return `needs approval (${e.reason}): ${e.command}`;
    case 'approval_decided': {
      const command = requested[e.approvalId]?.command ?? '';
      if (e.by === 'remembered') return `auto-approved (you allowed this for the job): ${command}`;
      if (e.by === 'you') {
        return `${e.decision} by you${e.remember ? ', and for the rest of this job' : ''}: ${command}`;
      }
      return `${e.decision} (${e.by}): ${command}`;
    }
    default:
      return '';
  }
}

// What the worker last said before asking, which is usually why it wants to do this.
export function agentSaid(state: JobState, approvalId: string): string | undefined {
  const at = state.timeline.findIndex(
    (e) => e.kind === 'approval_requested' && e.approvalId === approvalId,
  );
  for (let i = at - 1; i >= 0; i--) {
    const e = state.timeline[i];
    if (e?.kind === 'job_text') return e.text.split('\n')[0];
  }
  return undefined;
}

export interface Derived {
  jobs: JobState[];
  exchanges: Exchange[];
  approvals: { approval: ApprovalEvent; job: JobState }[];
  needsYou: JobState[];
}

export function derive(events: MaiEvent[]): Derived {
  const jobs = new Map<string, JobState>();
  const exchanges = new Map<string, Exchange>();

  for (const e of events) {
    if (e.kind === 'user_input') {
      exchanges.set(e.inputId, {
        inputId: e.inputId,
        text: e.text,
        ts: e.ts,
        jobIds: [],
        ...(e.aboutJobId ? { aboutJobId: e.aboutJobId } : {}),
      });
      continue;
    }
    if (e.kind === 'desk_reply' || e.kind === 'desk_error') {
      const ex = exchanges.get(e.inputId);
      if (!ex) continue;
      if (e.kind === 'desk_reply') {
        ex.reply = e.text;
        ex.jobIds = e.jobIds;
        if (e.scheduleIds) ex.scheduleIds = e.scheduleIds;
      } else {
        ex.error = e.message;
      }
      continue;
    }
    if (e.kind === 'job_created') {
      jobs.set(e.job.id, {
        job: e.job,
        status: e.job.status,
        timeline: [],
        pendingApprovals: [],
        requested: {},
        dismissed: false,
        lastTs: e.ts,
        ...(e.retryOf ? { retryOf: e.retryOf } : {}),
      });
      continue;
    }
    const state = e.jobId ? jobs.get(e.jobId) : undefined;
    if (!state) continue;
    if (e.kind === 'inbox_dismissed') {
      state.dismissed = true;
      continue;
    }
    state.timeline.push(e);
    state.lastTs = e.ts;
    if (e.kind === 'approval_requested') {
      state.pendingApprovals.push(e);
      state.requested[e.approvalId] = e;
    }
    if (e.kind === 'approval_decided') {
      state.pendingApprovals = state.pendingApprovals.filter((a) => a.approvalId !== e.approvalId);
    }
    if (e.kind === 'job_status') {
      state.status = e.status;
      state.error = e.error;
      if (!ACTIVE.includes(e.status)) state.finishedAt = e.ts;
    } else if (e.kind === 'job_report') {
      state.report = e.report;
    }
  }

  const all = [...jobs.values()].sort((a, b) => b.job.createdAt - a.job.createdAt);
  return {
    jobs: all,
    exchanges: [...exchanges.values()],
    approvals: all.flatMap((job) => job.pendingApprovals.map((approval) => ({ approval, job }))),
    needsYou: all.filter(needsAttention),
  };
}

// Every word must appear somewhere in the job's title, instructions, folder, branch or report.
export function searchJobs(jobs: JobState[], query: string): JobState[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return jobs;
  return jobs.filter((j) => {
    const r = j.report;
    const haystack = [
      j.job.title,
      j.job.spec.prompt,
      j.job.cwd,
      j.job.branch,
      j.status,
      r?.summary,
      ...(r?.changes ?? []),
      ...(r?.artifacts ?? []),
    ]
      .join('\n')
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

// "42s", "3m", "5h", "2d" for tight columns.
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// "41s", "2m 14s", "1h 5m" for sentences.
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export interface JobCounts {
  running: number;
  queued: number;
  needsYou: number;
}

export function jobCounts(jobs: JobState[]): JobCounts {
  let running = 0;
  let queued = 0;
  let needsYou = 0;
  for (const j of jobs) {
    if (j.status === 'running') running++;
    else if (j.status === 'queued') queued++;
    if (statusLabel(j) === 'needs you') needsYou++;
  }
  return { running, queued, needsYou };
}

export const usageLevel = (pct: number | null): 'ok' | 'warn' | 'danger' =>
  pct === null || pct < 80 ? 'ok' : pct < 95 ? 'warn' : 'danger';

// "16:30" when the reset is within a day, otherwise "Sat 04:00".
export function resetLabel(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return at.getTime() - now < 86_400_000
    ? time
    : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

export const shortPath = (path: string, home: string) =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

// Absolute or ~ paths in a command that are not inside the job folder. A hint for the
// approval card only; the daemon's policy does the real checking.
export function outsidePaths(command: string, cwd: string, home: string): string[] {
  const found = command.match(/(?:^|[\s"'=])(~(?=\/|\s|$)[^\s"';|&]*|\/[^\s"';|&]+)/g) ?? [];
  const paths = found.map((m) => m.replace(/^[\s"'=]/, ''));
  const expand = (p: string) => (p.startsWith('~') && home ? home + p.slice(1) : p);
  return [...new Set(paths)].filter((p) => {
    const full = expand(p).replace(/\/+$/, '');
    return full !== cwd && !full.startsWith(`${cwd}/`);
  });
}
