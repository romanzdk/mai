import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, DeskContext, WorkerArgs } from '@mai/agent';
import type { Usage } from '@mai/protocol';
import { afterEach, expect, test, vi } from 'vitest';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { Store } from './store';

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => new Promise((r) => setTimeout(r, 20));
const usageAt = (pct: number): Usage => ({
  fiveHour: { pct, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
  week: { pct: 10, resetsAt: null },
  models: [],
  checkedAt: Date.now(),
});

function setup(agent: Partial<Agent> = {}, store = new Store(':memory:')) {
  return new Core({
    store,
    agent: { ...createFakeAgent(), ...agent },
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
}

test('settings are validated, saved, and survive a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mai-')), 'mai.db');
  const reconfigured: string[] = [];
  const first = setup({ reconfigure: () => reconfigured.push('x') }, new Store(path));
  first.updateSettings({ maxParallel: 3, deskModel: 'claude-sonnet-5-5', workspace: 'nope' });
  expect(first.settings).toMatchObject({ maxParallel: 3, deskModel: 'claude-sonnet-5-5' });
  expect(first.settings.workspace).toBe(tmpdir());
  expect(reconfigured).toHaveLength(1);
  first.updateSettings({ maxParallel: 4 });
  expect(reconfigured).toHaveLength(1);
  first.store.close();

  const second = setup({}, new Store(path));
  expect(second.settings).toMatchObject({ maxParallel: 4, deskModel: 'claude-sonnet-5-5' });
});

test('workers get the step and cost caps and the configured model', async () => {
  const calls: Omit<WorkerArgs, 'apiKeyMode' | 'headedBrowser'>[] = [];
  const core = setup({
    async runWorker(args) {
      calls.push(args);
      return { ok: true, result: 'r', transcript: 't' };
    },
  });
  core.updateSettings({ jobMaxTurns: 50, jobMaxCostUsd: 3, workerModel: 'claude-sonnet-5-5' });
  await core.handleInput('i', 'a job');
  await settle();
  expect(calls[0]).toMatchObject({ maxTurns: 50, maxCostUsd: 3, model: 'claude-sonnet-5-5' });
});

test('new jobs wait while a plan window is over the limit; "run anyway" lets them start', async () => {
  let usage = usageAt(97);
  const desks: DeskContext[] = [];
  const core = setup({
    usage: async () => usage,
    async desk(text, ctx) {
      desks.push(ctx);
      return {
        reply: 'ok',
        jobs: [{ title: text, prompt: text }],
        cancel: [],
        schedules: [],
        unschedule: [],
      };
    },
  });
  const paused: (string | null)[] = [];
  core.subscribe((m) => m.type === 'scheduler' && paused.push(m.paused));
  await core.refreshUsage(true);
  expect(core.paused).toMatch(/^the 5-hour limit is at 97%/);
  await core.handleInput('i', 'held job');
  await settle();
  expect(core.store.jobs()[0]?.status).toBe('queued');
  expect(desks[0]?.notice).toContain('on hold');

  core.resumeAnyway();
  await settle();
  expect(core.paused).toBeNull();
  expect(core.store.jobs()[0]?.status).toBe('done');

  usage = usageAt(10);
  await core.refreshUsage(true);
  expect(paused[0]).toMatch(/97%/);
  expect(paused.at(-1)).toBeNull();
});

test('the hold can be switched off and follows the threshold', async () => {
  const core = setup({ usage: async () => usageAt(90) });
  await core.refreshUsage(true);
  expect(core.paused).toBeNull();
  core.updateSettings({ pauseAtUsagePct: 85 });
  expect(core.paused).toMatch(/90%/);
  core.updateSettings({ pauseAtUsagePct: 100 });
  expect(core.paused).toBeNull();
});

test('a job with no activity is stopped as hung; waiting for approval does not count', async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const core = setup({
    async runWorker({ signal, requestApproval, onEvent }) {
      onEvent({ kind: 'text', text: 'starting' });
      await requestApproval({
        ruleId: 'sudo',
        reason: 'runs as root',
        tool: 'Bash',
        command: 'sudo x',
      });
      await new Promise<void>((r) => {
        release = r;
        signal.addEventListener('abort', () => r(), { once: true });
      });
      return { ok: false, result: 'aborted', transcript: 't' };
    },
  });
  core.updateSettings({ jobIdleMinutes: 2 });
  await core.handleInput('i', 'a job');
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  const job = core.store.jobs()[0];
  expect(job?.status).toBe('waiting_approval');

  const pending = core.store.pendingApprovals()[0];
  core.decide(pending?.id ?? '', 'approved', 'you');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(core.store.job(job?.id ?? '')?.status).toBe('running');
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  expect(core.store.job(job?.id ?? '')?.status).toBe('failed');
  expect(core.store.eventsSince(0).at(-1)).toMatchObject({
    error: 'stopped: no activity for 2 minutes',
  });
  expect(core.store.recentReports(1)).toHaveLength(1);
  release();
});
