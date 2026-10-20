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
  dismissed: boolean;
}

export interface Exchange {
  inputId: string;
  text: string;
  ts: number;
  reply?: string;
  error?: string;
  jobIds: string[];
  aboutJobId?: string;
}

export const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_input'];

export function timelineLine(e: MaiEvent): string {
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
    case 'approval_decided':
      return `${e.decision}${e.by === 'you' ? ' by you' : ` (${e.by})`}`;
    default:
      return '';
  }
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
        dismissed: false,
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
    if (e.kind === 'approval_requested') state.pendingApprovals.push(e);
    if (e.kind === 'approval_decided') {
      state.pendingApprovals = state.pendingApprovals.filter((a) => a.approvalId !== e.approvalId);
    }
    if (e.kind === 'job_status') {
      state.status = e.status;
      state.error = e.error;
    } else if (e.kind === 'job_report') {
      state.report = e.report;
    }
  }

  const all = [...jobs.values()].sort((a, b) => b.job.createdAt - a.job.createdAt);
  return {
    jobs: all,
    exchanges: [...exchanges.values()],
    approvals: all.flatMap((job) => job.pendingApprovals.map((approval) => ({ approval, job }))),
    needsYou: all.filter(
      (j) => !ACTIVE.includes(j.status) && !j.dismissed && (j.report?.needs_you.length ?? 0) > 0,
    ),
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
