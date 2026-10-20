import { expect, test } from 'vitest';
import {
  applySettings,
  type ClientMessage,
  DEFAULT_SETTINGS,
  decode,
  encode,
  PROTOCOL_VERSION,
  type Settings,
} from './index';

test('round-trips a message', () => {
  const ping: ClientMessage = { v: PROTOCOL_VERSION, type: 'ping', id: 'a', t: 1 };
  expect(decode(encode(ping))).toEqual(ping);
});

test('rejects garbage and other protocol versions', () => {
  expect(decode('not json')).toBeNull();
  expect(decode('null')).toBeNull();
  expect(decode(JSON.stringify({ v: PROTOCOL_VERSION + 1, type: 'ping' }))).toBeNull();
  expect(decode(JSON.stringify({ v: PROTOCOL_VERSION }))).toBeNull();
});

test('settings patches keep only valid keys, types and ranges', () => {
  const base: Settings = { ...DEFAULT_SETTINGS, workspace: '/Users/me/mai' };
  expect(
    applySettings(base, {
      maxParallel: 99,
      jobIdleMinutes: 0,
      jobMaxCostUsd: 12.6,
      notifications: false,
      workerModel: '  claude-sonnet-5-5 ',
      workspace: 'relative/path',
      apiKeyMode: 'yes',
      unknown: 1,
    }),
  ).toEqual({
    ...base,
    maxParallel: 8,
    jobIdleMinutes: 1,
    jobMaxCostUsd: 13,
    notifications: false,
    workerModel: 'claude-sonnet-5-5',
  });
  expect(applySettings(base, null)).toEqual(base);
  expect(applySettings(base, { workspace: '/tmp/ws', deskModel: '' })).toEqual({
    ...base,
    workspace: '/tmp/ws',
  });
});
