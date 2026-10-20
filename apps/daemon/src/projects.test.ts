import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Agent, DeskContext, WorkerArgs } from '@mai/agent';
import { expect, test } from 'vitest';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { Store } from './store';

const settle = () => new Promise((r) => setTimeout(r, 100));
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function repo(withCommit = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'mai-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  if (withCommit) {
    writeFileSync(join(dir, 'README.md'), 'hi\n');
    git(dir, 'add', '.');
    git(
      dir,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'init',
    );
  }
  return dir;
}

function setup(cwd: string) {
  const workerCalls: Omit<WorkerArgs, 'apiKeyMode' | 'headedBrowser'>[] = [];
  const desks: DeskContext[] = [];
  const agent: Agent = {
    ...createFakeAgent(),
    async desk(_text, ctx) {
      desks.push(ctx);
      return { reply: 'ok', jobs: [{ title: 't', prompt: 'p', cwd }], cancel: [] };
    },
    async runWorker(args) {
      workerCalls.push(args);
      return { ok: true, result: 'r', transcript: 't' };
    },
  };
  const workspace = mkdtempSync(join(tmpdir(), 'mai-ws-'));
  const core = new Core({
    store: new Store(':memory:'),
    agent,
    workspace,
    home: tmpdir(),
    maxParallel: 2,
  });
  return { core, workerCalls, desks, workspace };
}

test('a git project job runs in its own worktree and branch; the checkout is untouched', async () => {
  const project = repo();
  const { core, workerCalls, workspace } = setup(project);
  await core.handleInput('i', 'add a CI workflow');
  await settle();
  const [job] = core.store.jobs();
  expect(job).toMatchObject({
    status: 'done',
    project,
    branch: `mai/${job?.id}`,
    cwd: join(workspace, 'jobs', job?.id ?? '', project.split('/').at(-1) ?? ''),
  });
  expect(existsSync(join(job?.cwd ?? '', 'README.md'))).toBe(true);
  expect(git(project, 'branch', '--list', `mai/${job?.id}`)).toContain(`mai/${job?.id}`);
  expect(git(project, 'branch', '--show-current')).toBe('main');
  expect(workerCalls[0]).toMatchObject({
    cwd: job?.cwd,
    jobDir: join(workspace, 'jobs', job?.id ?? ''),
    git: { project, branch: `mai/${job?.id}` },
  });
});

test('a repo without commits fails with a clear reason', async () => {
  const { core } = setup(repo(false));
  await core.handleInput('i', 'x');
  await settle();
  expect(core.store.eventsSince(0).at(-1)).toMatchObject({
    kind: 'job_status',
    status: 'failed',
    error: expect.stringContaining('could not create a git worktree'),
  });
});

test('a plain folder is used as is, without free deletes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mai-plain-'));
  const { core, workerCalls } = setup(folder);
  await core.handleInput('i', 'x');
  await settle();
  expect(core.store.jobs()[0]).toMatchObject({ status: 'done', cwd: folder });
  expect(core.store.jobs()[0]?.branch).toBeUndefined();
  expect(workerCalls[0]?.jobDir).toBeUndefined();
  expect(workerCalls[0]?.git).toBeUndefined();
});

test('a follow-up gives the desk that job, its report and its last steps', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'mai-plain-'));
  const { core, desks } = setup(folder);
  await core.handleInput('a', 'first');
  await settle();
  const jobId = core.store.jobs()[0]?.id ?? '';
  await core.handleInput('b', 'why did it do that?', jobId);
  expect(desks[0]?.about).toBeUndefined();
  expect(desks[1]?.about).toMatchObject({
    job: { id: jobId },
    report: { summary: 'Fake report.' },
  });
  expect(
    core.store.eventsSince(0).find((e) => e.kind === 'user_input' && e.inputId === 'b'),
  ).toMatchObject({
    aboutJobId: jobId,
  });
});

test('an older database gets the new job columns', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mai-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(
    'CREATE TABLE jobs (id TEXT PRIMARY KEY, title TEXT NOT NULL, spec TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER)',
  );
  old.close();
  const store = new Store(path);
  const base = {
    title: 't',
    spec: { title: 't', prompt: 'p' },
    model: 'm',
    cwd: '/x',
    createdAt: 1,
    finishedAt: null,
  };
  store.insertJob({ ...base, id: 'a', status: 'done', project: '/p', branch: 'mai/a' });
  expect(store.job('a')).toMatchObject({ project: '/p', branch: 'mai/a' });
});
