import { expect, test } from 'vitest';
import { cronMatches, nextRun, parseCron } from './cron';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const next = (expr: string, from: Date) => nextRun(parseCron(expr), from);

test('weekdays at 07:30', () => {
  const c = parseCron('30 7 * * 1-5');
  expect(cronMatches(c, at(2026, 10, 20, 7, 30))).toBe(true); // Tuesday
  expect(cronMatches(c, at(2026, 10, 24, 7, 30))).toBe(false); // Saturday
  expect(next('30 7 * * 1-5', at(2026, 10, 23, 8, 0))).toEqual(at(2026, 10, 26, 7, 30)); // Fri → Mon
});

test('steps, lists and Sunday as 7', () => {
  expect(next('*/15 * * * *', at(2026, 1, 1, 10, 1))).toEqual(at(2026, 1, 1, 10, 15));
  expect(next('0 9,17 * * *', at(2026, 1, 1, 9, 0))).toEqual(at(2026, 1, 1, 17, 0));
  expect(next('0 12 * * 7', at(2026, 10, 20))).toEqual(at(2026, 10, 25, 12, 0));
  expect(next('0 8 1-7/3 * *', at(2026, 3, 1, 9))).toEqual(at(2026, 3, 4, 8, 0));
});

test('day of month OR weekday when both are set', () => {
  // 13th of the month, or any Friday.
  expect(next('0 0 13 * 5', at(2026, 10, 10))).toEqual(at(2026, 10, 13, 0, 0));
  expect(next('0 0 13 * 5', at(2026, 10, 13, 1))).toEqual(at(2026, 10, 16, 0, 0));
});

test('rare dates are found; impossible ones return null', () => {
  expect(next('0 0 29 2 *', at(2026, 3, 1))).toEqual(at(2028, 2, 29, 0, 0));
  expect(next('0 0 31 2 *', at(2026, 1, 1))).toBeNull();
});

test.each([
  ['too few fields', '0 8 * *'],
  ['minute 60', '60 8 * * *'],
  ['backwards range', '0 8 * * 5-1'],
  ['letters', '0 8 * * mon'],
  ['zero step', '*/0 * * * *'],
])('rejects %s', (_, expr) => {
  expect(() => parseCron(expr)).toThrow();
});
