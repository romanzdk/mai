import { expect, test } from 'vitest';
import { type ClientMessage, decode, encode, PROTOCOL_VERSION } from './index';

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
