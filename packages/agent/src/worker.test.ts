import { expect, test } from 'vitest';
import { stoppedBecause } from './worker';

test('cap stops are explained in plain words', () => {
  const caps = { maxTurns: 200, maxCostUsd: 20 };
  expect(stoppedBecause('error_max_turns', caps)).toBe(
    'stopped: reached the limit of 200 steps (change it in Settings)',
  );
  expect(stoppedBecause('error_max_budget_usd', caps)).toBe(
    'stopped: reached the cost cap of $20 (change it in Settings)',
  );
  expect(stoppedBecause('error_during_execution', caps)).toBe('stopped: during execution');
});
