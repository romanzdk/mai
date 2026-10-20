import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@mai/agent';
import { expect, test } from 'vitest';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { Store } from './store';

const at = (d: number, h: number, m = 0) => new Date(2030, 0, d, h, m).getTime();
const settle = () => new Promise((r) => setTimeout(r, 20));
const daily8 = { title: 'Brief', prompt: 'brief me', cron: '0 8 * * *', when: 'daily at 08:00' };

function setup(agent: Partial<Agent> = {}, store = new Store(':memory:')) {
  return new Core({
    store,
    agent: { ...createFakeAgent(), ...agent },
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
}

const runsOf = (core: Core, id: string) => core.store.jobs().filter((j) => j.scheduleId === id);

test('the desk creates schedules and says so in its reply', async () => {
  const core = setup();
  await core.handleInput('i', 'every day check the weather');
  const [s] = core.schedules;
  expect(s).toMatchObject({ title: 'check the weather', cron: '0 8 * * *', enabled: true });
  expect(core.store.eventsSince(0).find((e) => e.kind === 'desk_reply')).toMatchObject({
    scheduleIds: [s?.id],
  });
});

test('a schedule fires once at its minute, as a normal job', async () => {
  const core = setup();
  const s = core.createSchedule(daily8, at(1, 7));
  core.tickSchedules(at(1, 7, 59));
  expect(runsOf(core, s.id)).toHaveLength(0);
  core.tickSchedules(at(1, 8, 0) + 20_000);
  core.tickSchedules(at(1, 8, 1));
  await settle();
  const runs = runsOf(core, s.id);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.spec.prompt).toContain('scheduled run: daily at 08:00');
  expect(core.store.job(runs[0]?.id ?? '')?.status).toBe('done');
  expect(core.schedules[0]).toMatchObject({
    lastJobId: runs[0]?.id,
    lastRunAt: at(1, 8, 0) + 20_000,
  });
});

test('a run missed while asleep happens once on waking, but not if it is over 12 h old', () => {
  const core = setup();
  const s = core.createSchedule(daily8, at(1, 7));
  core.tickSchedules(at(1, 10));
  core.tickSchedules(at(1, 10, 1));
  expect(runsOf(core, s.id)).toHaveLength(1);

  const old = core.createSchedule({ ...daily8, title: 'Old' }, at(1, 7));
  core.tickSchedules(at(2, 21));
  expect(runsOf(core, old.id)).toHaveLength(0);
});

test('runs never stack: a still-running previous run skips the next one', async () => {
  const core = setup();
  const s = core.createSchedule({ ...daily8, prompt: 'slow crawl' }, at(1, 7));
  core.tickSchedules(at(1, 8));
  await settle();
  core.tickSchedules(at(2, 8));
  expect(runsOf(core, s.id)).toHaveLength(1);
});

test('pausing stops runs, resuming does not replay them, and run now always works', () => {
  const core = setup();
  const s = core.createSchedule(daily8, at(1, 7));
  expect(core.updateSchedule(s.id, { enabled: false })).toBe(true);
  core.tickSchedules(at(1, 9));
  expect(runsOf(core, s.id)).toHaveLength(0);
  core.updateSchedule(s.id, { enabled: true }, at(1, 9));
  core.tickSchedules(at(1, 9, 30));
  expect(runsOf(core, s.id)).toHaveLength(0);
  expect(core.runScheduleNow(s.id)).toBe(true);
  expect(runsOf(core, s.id)).toHaveLength(1);
});

test('a bad cron is refused; time and wording can be changed', () => {
  const core = setup();
  const s = core.createSchedule(daily8, at(1, 7));
  expect(core.updateSchedule(s.id, { cron: '99 8 * * *' })).toBe(false);
  expect(core.updateSchedule(s.id, { cron: '30 7 * * 1-5', when: 'weekdays at 07:30' })).toBe(true);
  expect(core.schedules[0]).toMatchObject({ cron: '30 7 * * 1-5', when: 'weekdays at 07:30' });
  expect(() => core.createSchedule({ ...daily8, cron: 'nope' })).toThrow();
});

test('the desk can remove a schedule and reports unknown ids', async () => {
  const core = setup({
    async desk(text) {
      return {
        reply: 'Removed.',
        jobs: [],
        cancel: [],
        schedules: [],
        unschedule: [text.split(' ')[1] ?? ''],
      };
    },
  });
  const s = core.createSchedule(daily8);
  await core.handleInput('a', `remove ${s.id}`);
  await core.handleInput('b', 'remove nope0000');
  expect(core.schedules).toEqual([]);
  expect(core.store.eventsSince(0).filter((e) => e.kind === 'desk_error')).toMatchObject([
    { message: 'no schedule nope0000 to remove' },
  ]);
});

test('schedules survive a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mai-')), 'mai.db');
  const first = setup({}, new Store(path));
  const s = first.createSchedule(daily8);
  first.store.close();
  expect(setup({}, new Store(path)).schedules).toMatchObject([{ id: s.id, title: 'Brief' }]);
});
