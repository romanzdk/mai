import { expect, test } from 'vitest';
import { parseDeskOutput, visibleReply } from './parse';

test('plain answer has no jobs', () => {
  expect(parseDeskOutput("It's 09:30.")).toEqual({
    reply: "It's 09:30.",
    jobs: [],
    cancel: [],
    schedules: [],
    unschedule: [],
  });
});

test('dispatch block becomes jobs and is removed from the reply', () => {
  const out = parseDeskOutput(
    'On it.\n<dispatch>[{"title":"Notes","prompt":"Create ~/Desktop/notes","cwd":"/tmp/x"}]</dispatch>',
  );
  expect(out).toEqual({
    reply: 'On it.',
    jobs: [{ title: 'Notes', prompt: 'Create ~/Desktop/notes', cwd: '/tmp/x' }],
    cancel: [],
    schedules: [],
    unschedule: [],
  });
});

test('a single object is accepted as one job', () => {
  expect(parseDeskOutput('<dispatch>{"title":"a","prompt":"b"}</dispatch>').jobs).toEqual([
    { title: 'a', prompt: 'b' },
  ]);
});

test.each([
  ['bad JSON', 'Ok <dispatch>[{title:}]</dispatch>'],
  ['missing prompt', 'Ok <dispatch>[{"title":"a"}]</dispatch>'],
  ['relative cwd', 'Ok <dispatch>[{"title":"a","prompt":"b","cwd":"x"}]</dispatch>'],
  ['empty list', 'Ok <dispatch>[]</dispatch>'],
  ['unclosed block', 'Ok <dispatch>[{"title":"a","prompt":"b"}]'],
])('%s is reported, never half-dispatched', (_, text) => {
  const out = parseDeskOutput(text);
  expect(out.jobs).toEqual([]);
  expect(out.error).toBeTruthy();
  expect(out.reply).toBe('Ok');
});

test('streaming view hides the block and a partial opening tag', () => {
  expect(visibleReply('On it. <dispatch>[{"ti')).toBe('On it.');
  expect(visibleReply('On it. <disp')).toBe('On it.');
  expect(visibleReply('1 < 2')).toBe('1 < 2');
  expect(visibleReply('a <b>')).toBe('a <b>');
});

test('cancel block lists job ids', () => {
  expect(parseDeskOutput('Stopping it.\n<cancel>["ab12cd34"]</cancel>')).toEqual({
    reply: 'Stopping it.',
    jobs: [],
    cancel: ['ab12cd34'],
    schedules: [],
    unschedule: [],
  });
});

test('a bad cancel block also drops a valid dispatch', () => {
  const out = parseDeskOutput(
    'Ok <dispatch>[{"title":"a","prompt":"b"}]</dispatch><cancel>[42]</cancel>',
  );
  expect(out).toMatchObject({ reply: 'Ok', jobs: [], cancel: [] });
  expect(out.error).toContain('cancel');
});

test('streaming view hides a partial cancel tag', () => {
  expect(visibleReply('Stopping. <canc')).toBe('Stopping.');
  expect(visibleReply('Stopping. <cancel>["a')).toBe('Stopping.');
});

test('a schedule block needs a valid cron and a "when"', () => {
  const ok = parseDeskOutput(
    'Done.\n<schedule>[{"title":"Brief","prompt":"Summarise my inbox","cron":"30 7 * * 1-5","when":"weekdays at 07:30"}]</schedule>',
  );
  expect(ok).toMatchObject({
    reply: 'Done.',
    schedules: [
      {
        title: 'Brief',
        prompt: 'Summarise my inbox',
        cron: '30 7 * * 1-5',
        when: 'weekdays at 07:30',
      },
    ],
  });
  const bad = parseDeskOutput(
    'Done. <schedule>[{"title":"x","prompt":"y","cron":"every day","when":"daily"}]</schedule>',
  );
  expect(bad).toMatchObject({ schedules: [], error: expect.stringContaining('schedule') });
  expect(parseDeskOutput('Removed. <unschedule>["s1"]</unschedule>')).toMatchObject({
    reply: 'Removed.',
    unschedule: ['s1'],
  });
});
