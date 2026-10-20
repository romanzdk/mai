import type { EventBody, Job, MaiEvent } from '@mai/protocol';
import { expect, test } from 'vitest';
import {
  agentSaid,
  ago,
  clock,
  derive,
  duration,
  jobCounts,
  needsAttention,
  outsidePaths,
  resetLabel,
  searchJobs,
  shortPath,
  statusLabel,
  timelineLine,
  usageLevel,
} from './derive';

let id = 0;
const ev = (jobId: string | null, body: EventBody): MaiEvent => ({
  ...body,
  id: ++id,
  ts: id,
  jobId,
});
const job: Job = {
  id: 'j1',
  title: 'Notes',
  spec: { title: 'Notes', prompt: 'p' },
  status: 'queued',
  model: 'm',
  cwd: '/tmp',
  createdAt: 5,
  finishedAt: null,
};

test('folds events into exchanges and job state', () => {
  const report = { summary: 'Made it.', changes: [], artifacts: [], needs_you: [] };
  const { jobs, exchanges } = derive([
    ev(null, { kind: 'user_input', text: 'make notes', inputId: 'a' }),
    ev(null, { kind: 'desk_reply', text: 'On it.', inputId: 'a', jobIds: ['j1'] }),
    ev('j1', { kind: 'job_created', job }),
    ev('j1', { kind: 'job_status', status: 'running' }),
    ev('j1', { kind: 'job_tool', tool: 'Bash', summary: 'mkdir x' }),
    ev('j1', { kind: 'job_report', report }),
    ev('j1', { kind: 'job_status', status: 'done' }),
    ev(null, { kind: 'user_input', text: 'hi', inputId: 'b' }),
    ev(null, { kind: 'desk_error', message: 'offline', inputId: 'b' }),
  ]);
  expect(exchanges).toMatchObject([
    { inputId: 'a', reply: 'On it.', jobIds: ['j1'] },
    { inputId: 'b', error: 'offline' },
  ]);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ status: 'done', report });
  expect(jobs[0]?.timeline.map((e) => e.kind)).toEqual([
    'job_status',
    'job_tool',
    'job_report',
    'job_status',
  ]);
});

test('events for unknown jobs or inputs are ignored', () => {
  const { jobs, exchanges } = derive([
    ev('ghost', { kind: 'job_status', status: 'done' }),
    ev(null, { kind: 'desk_reply', text: 'x', inputId: 'nope', jobIds: [] }),
  ]);
  expect(jobs).toEqual([]);
  expect(exchanges).toEqual([]);
});

test('pending approvals and needs-you reports make up the inbox', () => {
  const report = { summary: 's', changes: [], artifacts: [], needs_you: ['check it'] };
  const ask = (approvalId: string) =>
    ({
      kind: 'approval_requested',
      approvalId,
      ruleId: 'delete',
      tool: 'Bash',
      command: 'rm x',
      reason: 'deletes files',
    }) as const;
  const job2 = { ...job, id: 'j2', createdAt: 6 };
  const d = derive([
    ev('j1', { kind: 'job_created', job }),
    ev('j1', ask('a1')),
    ev('j1', ask('a2')),
    ev('j1', { kind: 'approval_decided', approvalId: 'a1', decision: 'approved', by: 'you' }),
    ev('j2', { kind: 'job_created', job: job2, retryOf: 'j1' }),
    ev('j2', { kind: 'job_report', report }),
    ev('j2', { kind: 'job_status', status: 'done' }),
  ]);
  expect(d.approvals.map((a) => a.approval.approvalId)).toEqual(['a2']);
  expect(d.needsYou.map((j) => j.job.id)).toEqual(['j2']);
  expect(d.jobs.find((j) => j.job.id === 'j2')?.retryOf).toBe('j1');

  const after = derive([
    ev('j2', { kind: 'job_created', job: job2 }),
    ev('j2', { kind: 'job_report', report }),
    ev('j2', { kind: 'job_status', status: 'done' }),
    ev('j2', { kind: 'inbox_dismissed' }),
  ]);
  expect(after.needsYou).toEqual([]);
});

test('history search matches every word across title, prompt and report', () => {
  const report = {
    summary: 'Cheapest is Samsung 990',
    changes: [],
    artifacts: ['/x/nvme.md'],
    needs_you: [],
  };
  const { jobs } = derive([
    ev('j1', {
      kind: 'job_created',
      job: { ...job, title: 'NVMe prices', spec: { title: 't', prompt: 'alza.cz' } },
    }),
    ev('j1', { kind: 'job_report', report }),
    ev('j2', {
      kind: 'job_created',
      job: { ...job, id: 'j2', title: 'CI workflow', branch: 'mai/j2' },
    }),
  ]);
  const ids = (q: string) => searchJobs(jobs, q).map((j) => j.job.id);
  expect(ids('')).toHaveLength(2);
  expect(ids('samsung alza')).toEqual(['j1']);
  expect(ids('NVME.MD')).toEqual(['j1']);
  expect(ids('mai/j2')).toEqual(['j2']);
  expect(ids('samsung workflow')).toEqual([]);
});

test('time helpers', () => {
  expect(clock(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  expect([ago(5_000), ago(125_000), ago(3 * 3600_000), ago(50 * 3600_000)]).toEqual([
    '5s',
    '2m',
    '3h',
    '2d',
  ]);
  expect([duration(41_000), duration(134_000), duration(3_900_000)]).toEqual([
    '41s',
    '2m 14s',
    '1h 5m',
  ]);
});

test('paths are shown with ~ and outside-folder targets are found', () => {
  expect(shortPath('/Users/me/mai/jobs/a', '/Users/me')).toBe('~/mai/jobs/a');
  expect(shortPath('/Users/meme/x', '/Users/me')).toBe('/Users/meme/x');
  const cwd = '/Users/me/mai/jobs/a';
  expect(outsidePaths('rm -rf ~/Documents/old', cwd, '/Users/me')).toEqual(['~/Documents/old']);
  expect(outsidePaths(`rm -rf ${cwd}/build ${cwd}`, cwd, '/Users/me')).toEqual([]);
  expect(outsidePaths('rm "/etc/hosts" 2>/dev/null', cwd, '/Users/me')).toEqual(['/etc/hosts']);
  expect(outsidePaths('git push origin main', cwd, '/Users/me')).toEqual([]);
});

test('failed jobs need attention unless you denied them; status labels follow', () => {
  const base = (status: Parameters<typeof ev>[1]) =>
    derive([ev('j1', { kind: 'job_created', job }), ev('j1', status)]).jobs[0];
  const failed = base({ kind: 'job_status', status: 'failed', error: 'boom' });
  const denied = base({ kind: 'job_status', status: 'failed', error: 'you denied: rm x' });
  const waiting = base({ kind: 'job_status', status: 'waiting_approval' });
  expect(failed && needsAttention(failed)).toBe(true);
  expect(denied && needsAttention(denied)).toBe(false);
  expect(waiting && statusLabel(waiting)).toBe('needs you');
  expect(failed && statusLabel(failed)).toBe('failed');
  expect(failed?.finishedAt).toBeGreaterThan(0);
});

test('approval context: what the agent said before, and remembered decisions', () => {
  const ask = {
    kind: 'approval_requested',
    approvalId: 'a1',
    ruleId: 'git-push',
    tool: 'Bash',
    command: 'git push',
    reason: 'pushes',
  } as const;
  const [state] = derive([
    ev('j1', { kind: 'job_created', job }),
    ev('j1', { kind: 'job_text', text: 'Tests pass, publishing.\nmore' }),
    ev('j1', ask),
    ev('j1', {
      kind: 'approval_decided',
      approvalId: 'a1',
      decision: 'approved',
      by: 'remembered',
    }),
  ]).jobs;
  if (!state) throw new Error('no job');
  expect(agentSaid(state, 'a1')).toBe('Tests pass, publishing.');
  const decided = state.timeline.at(-1);
  expect(decided && timelineLine(decided, state.requested)).toBe(
    'auto-approved (you allowed this for the job): git push',
  );
});

test('status bar helpers: job counts, usage levels, reset labels', () => {
  const { jobs } = derive([
    ev('a', { kind: 'job_created', job: { ...job, id: 'a' } }),
    ev('a', { kind: 'job_status', status: 'running' }),
    ev('b', { kind: 'job_created', job: { ...job, id: 'b' } }),
    ev('c', { kind: 'job_created', job: { ...job, id: 'c' } }),
    ev('c', { kind: 'job_status', status: 'waiting_approval' }),
  ]);
  expect(jobCounts(jobs)).toEqual({ running: 1, queued: 1, needsYou: 1 });
  expect([usageLevel(null), usageLevel(79), usageLevel(80), usageLevel(95)]).toEqual([
    'ok',
    'ok',
    'warn',
    'danger',
  ]);
  const now = new Date(2026, 9, 20, 12, 0).getTime();
  expect(resetLabel(new Date(2026, 9, 20, 16, 30).toISOString(), now)).toBe('16:30');
  expect(resetLabel(new Date(2026, 9, 24, 4, 0).toISOString(), now)).toMatch(/04:00$/);
  expect(resetLabel(new Date(2026, 9, 24, 4, 0).toISOString(), now)).not.toBe('04:00');
  expect(resetLabel('garbage', now)).toBe('');
});
