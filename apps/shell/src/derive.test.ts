import type { EventBody, Job, MaiEvent } from '@mai/protocol';
import { expect, test } from 'vitest';
import { derive } from './derive';

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
