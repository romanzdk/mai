import type { Job, JobStatus, MaiEvent, Report } from '@mai/protocol';

export interface JobState {
  job: Job;
  status: JobStatus;
  error?: string;
  timeline: MaiEvent[];
  report?: Report;
}

export interface Exchange {
  inputId: string;
  text: string;
  ts: number;
  reply?: string;
  error?: string;
  jobIds: string[];
}

export const ACTIVE: JobStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_input'];

export function timelineLine(e: MaiEvent): string {
  switch (e.kind) {
    case 'job_tool':
      return `${e.tool} ${e.summary}`;
    case 'job_text':
      return e.text.split('\n')[0] ?? '';
    case 'job_status':
      return e.error ? `${e.status}: ${e.error}` : e.status;
    case 'job_report':
      return e.report.summary;
    default:
      return '';
  }
}

export function derive(events: MaiEvent[]): { jobs: JobState[]; exchanges: Exchange[] } {
  const jobs = new Map<string, JobState>();
  const exchanges = new Map<string, Exchange>();

  for (const e of events) {
    if (e.kind === 'user_input') {
      exchanges.set(e.inputId, { inputId: e.inputId, text: e.text, ts: e.ts, jobIds: [] });
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
      jobs.set(e.job.id, { job: e.job, status: e.job.status, timeline: [] });
      continue;
    }
    const state = e.jobId ? jobs.get(e.jobId) : undefined;
    if (!state) continue;
    state.timeline.push(e);
    if (e.kind === 'job_status') {
      state.status = e.status;
      state.error = e.error;
    } else if (e.kind === 'job_report') {
      state.report = e.report;
    }
  }

  return {
    jobs: [...jobs.values()].sort((a, b) => b.job.createdAt - a.job.createdAt),
    exchanges: [...exchanges.values()],
  };
}
