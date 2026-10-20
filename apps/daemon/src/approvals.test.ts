import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@mai/agent';
import type { MaiEvent } from '@mai/protocol';
import { expect, test, vi } from 'vitest';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { Store } from './store';

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup(agent: Agent = createFakeAgent(), store = new Store(':memory:')) {
  return new Core({ store, agent, workspace: tmpdir(), home: tmpdir(), maxParallel: 2 });
}

const events = (core: Core, jobId?: string) =>
  core.store.eventsSince(0).filter((e) => !jobId || e.jobId === jobId);
const statuses = (core: Core, jobId: string) =>
  events(core, jobId).flatMap((e) => (e.kind === 'job_status' ? [e.status] : []));
const pendingApproval = (core: Core) => {
  const decided = new Set(
    events(core).flatMap((e) => (e.kind === 'approval_decided' ? [e.approvalId] : [])),
  );
  return events(core).find(
    (e): e is Extract<MaiEvent, { kind: 'approval_requested' }> =>
      e.kind === 'approval_requested' && !decided.has(e.approvalId),
  );
};
const onlyJob = (core: Core) => core.store.jobs()[0]?.id ?? '';

test('a risky call pauses the job until approved, then it finishes', async () => {
  const core = setup();
  await core.handleInput('i', 'job: delete old stuff');
  await settle();
  const id = onlyJob(core);
  expect(core.store.job(id)?.status).toBe('waiting_approval');
  const req = pendingApproval(core);
  expect(req).toMatchObject({ ruleId: 'delete', command: 'rm -rf ~/Documents/old' });

  expect(core.decide(req?.approvalId ?? '', 'approved', 'you')).toBe(true);
  await settle();
  expect(statuses(core, id)).toEqual(['running', 'waiting_approval', 'running', 'done']);
});

test('denying fails the job with a clear reason and still writes a report', async () => {
  const core = setup();
  await core.handleInput('i', 'job: delete old stuff');
  await settle();
  const id = onlyJob(core);
  core.decide(pendingApproval(core)?.approvalId ?? '', 'denied', 'you');
  await settle();
  expect(core.store.job(id)?.status).toBe('failed');
  expect(events(core, id).at(-1)).toMatchObject({
    kind: 'job_status',
    error: 'you denied: rm -rf ~/Documents/old',
  });
  expect(core.store.recentReports(1)).toMatchObject([{ jobId: id }]);
});

test('a decision only counts once', async () => {
  const core = setup();
  await core.handleInput('i', 'job: delete old stuff');
  await settle();
  const approvalId = pendingApproval(core)?.approvalId ?? '';
  expect(core.decide(approvalId, 'approved', 'you')).toBe(true);
  expect(core.decide(approvalId, 'denied', 'you')).toBe(false);
  expect(core.decide('unknown', 'approved', 'you')).toBe(false);
});

test('"remember" auto-approves the same rule in the same job folder', async () => {
  const req = { ruleId: 'git-push', reason: 'pushes', tool: 'Bash', command: 'git push' };
  const answers: string[] = [];
  const agent: Agent = {
    ...createFakeAgent(),
    async runWorker({ requestApproval }) {
      answers.push(await requestApproval(req));
      answers.push(await requestApproval({ ...req, command: 'git push origin x' }));
      answers.push(await requestApproval({ ...req, ruleId: 'sudo', command: 'sudo ls' }));
      return { ok: true, result: 'r', transcript: 't' };
    },
  };
  const core = setup(agent);
  await core.handleInput('i', 'a job');
  await settle();
  core.decide(pendingApproval(core)?.approvalId ?? '', 'approved', 'you', true);
  await settle();
  expect(answers).toEqual(['approved', 'approved']);
  expect(pendingApproval(core)).toMatchObject({ ruleId: 'sudo' });
  const decided = events(core).filter((e) => e.kind === 'approval_decided');
  expect(decided).toMatchObject([
    { by: 'you', remember: true },
    { by: 'remembered', decision: 'approved' },
  ]);
});

test('cancel stops a running job, a waiting one and a queued one', async () => {
  const agent = createFakeAgent();
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await core.handleInput('a', 'job: slow one');
  await core.handleInput('b', 'job: delete things');
  await core.handleInput('c', 'job: queued behind');
  await settle();
  const byTitle = (t: string) => core.store.jobs().find((j) => j.title.includes(t));
  const [slow, waiting, queued] = [byTitle('slow'), byTitle('delete'), byTitle('queued')];
  expect([slow?.status, waiting?.status, queued?.status]).toEqual([
    'running',
    'waiting_approval',
    'queued',
  ]);

  expect(core.cancel(queued?.id ?? '')).toBe(true);
  expect(core.cancel(waiting?.id ?? '')).toBe(true);
  expect(core.cancel(slow?.id ?? '')).toBe(true);
  await settle();
  for (const job of [slow, waiting, queued]) {
    expect(core.store.job(job?.id ?? '')?.status).toBe('cancelled');
  }
  expect(events(core).find((e) => e.kind === 'approval_decided')).toMatchObject({
    by: 'cancel',
    decision: 'denied',
  });
  expect(core.store.recentReports(5)).toEqual([]);
  expect(core.cancel(slow?.id ?? '')).toBe(false);
});

test('retry re-runs a finished job as a new job', async () => {
  const core = setup();
  await core.handleInput('i', 'a job');
  await settle();
  const first = onlyJob(core);
  expect(core.retry(first)).toBe(true);
  await settle();
  const second = core.store.jobs().find((j) => j.id !== first);
  expect(second).toMatchObject({ status: 'done', spec: core.store.job(first)?.spec });
  expect(events(core, second?.id).find((e) => e.kind === 'job_created')).toMatchObject({
    retryOf: first,
  });
});

test('retry refuses a job that is still active', async () => {
  const core = setup();
  await core.handleInput('i', 'job: slow');
  await settle();
  expect(core.retry(onlyJob(core))).toBe(false);
});

test('the desk can cancel by id and reports unknown ids', async () => {
  const core = setup();
  await core.handleInput('a', 'job: slow');
  await settle();
  const id = onlyJob(core);
  await core.handleInput('b', `cancel ${id}`);
  await core.handleInput('c', 'cancel nope1234');
  await settle();
  expect(core.store.job(id)?.status).toBe('cancelled');
  expect(events(core).filter((e) => e.kind === 'desk_error')).toMatchObject([
    { message: 'no active job nope1234 to cancel' },
  ]);
});

test('a pending approval expires when the daemon restarts', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mai-')), 'mai.db');
  const first = setup(createFakeAgent(), new Store(path));
  await first.handleInput('i', 'job: delete it');
  await settle();
  const id = onlyJob(first);
  first.store.close();

  const second = setup(createFakeAgent(), new Store(path));
  expect(second.store.job(id)?.status).toBe('failed');
  expect(second.store.pendingApprovals()).toEqual([]);
  expect(events(second, id).filter((e) => e.kind === 'approval_decided')).toMatchObject([
    { decision: 'expired', by: 'restart' },
  ]);
});

test('login opens the terminal and polls until signed in', async () => {
  vi.useFakeTimers();
  let state: 'logged_in' | 'logged_out' = 'logged_out';
  let opened = 0;
  const core = setup({
    ...createFakeAgent(),
    authState: async () => state,
    openLogin: () => {
      opened++;
    },
  });
  const seen: string[] = [];
  core.subscribe((m) => m.type === 'auth' && seen.push(m.state));
  await core.checkAuth();
  core.login();
  await vi.advanceTimersByTimeAsync(3000);
  state = 'logged_in';
  await vi.advanceTimersByTimeAsync(3000);
  await vi.advanceTimersByTimeAsync(9000);
  vi.useRealTimers();
  expect(opened).toBe(1);
  expect(seen).toEqual(['logged_out', 'login_started', 'logged_in']);
  expect(core.authState.state).toBe('logged_in');
});
