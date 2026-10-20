import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@mai/agent';
import { expect, test } from 'vitest';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { Store } from './store';

const settle = () => new Promise((r) => setTimeout(r, 20));

test('never runs more workers than maxParallel and drains the queue', async () => {
  let active = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const agent: Agent = {
    ...createFakeAgent(),
    async desk() {
      return {
        reply: 'ok',
        jobs: [1, 2, 3].map((n) => ({ title: `job ${n}`, prompt: `p${n}` })),
        cancel: [],
      };
    },
    async runWorker() {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => release.push(r));
      active--;
      return { ok: true, result: 'r', transcript: 't' };
    },
  };
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await core.handleInput('i', 'three jobs');
  await settle();
  expect(active).toBe(2);
  expect(core.store.jobs('queued')).toHaveLength(1);

  while (release.length) {
    release.shift()?.();
    await settle();
  }
  expect(peak).toBe(2);
  expect(core.store.jobs().map((j) => j.status)).toEqual(['done', 'done', 'done']);
});

test('a failing worker fails the job with its error', async () => {
  const agent: Agent = {
    ...createFakeAgent(),
    async runWorker() {
      throw new Error('boom');
    },
  };
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await core.handleInput('i', 'a job');
  await settle();
  const [job] = core.store.jobs();
  expect(job?.status).toBe('failed');
  const last = core.store.eventsSince(0).at(-1);
  expect(last).toMatchObject({ kind: 'job_status', status: 'failed', error: 'boom' });
});

test('a job naming a missing project folder fails instead of creating it', async () => {
  const agent: Agent = {
    ...createFakeAgent(),
    async desk() {
      return {
        reply: 'ok',
        jobs: [{ title: 't', prompt: 'p', cwd: '/definitely/not/here' }],
        cancel: [],
      };
    },
  };
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await core.handleInput('i', 'x');
  await settle();
  expect(core.store.eventsSince(0).at(-1)).toMatchObject({
    status: 'failed',
    error: 'project folder does not exist: /definitely/not/here',
  });
});

test('a desk failure is recorded, not thrown', async () => {
  const agent: Agent = {
    ...createFakeAgent(),
    async desk() {
      throw new Error('not logged in');
    },
  };
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await core.handleInput('i', 'hi');
  expect(core.store.eventsSince(0).map((e) => e.kind)).toEqual(['user_input', 'desk_error']);
});

test('jobs left running by a previous daemon are failed on start; queued ones still run', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mai-')), 'mai.db');
  const store = new Store(path);
  const base = {
    spec: { title: 't', prompt: 'p' },
    model: 'm',
    cwd: tmpdir(),
    createdAt: 1,
    finishedAt: null,
  };
  store.insertJob({ ...base, id: 'old', title: 'old', status: 'running' });
  store.insertJob({ ...base, id: 'next', title: 'next', status: 'queued' });
  store.close();

  const core = new Core({
    store: new Store(path),
    agent: createFakeAgent(),
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  await settle();
  const byId = Object.fromEntries(core.store.jobs().map((j) => [j.id, j.status]));
  expect(byId).toEqual({ old: 'failed', next: 'done' });
});
