import { once } from 'node:events';
import { decode, encode, PROTOCOL_VERSION, type ServerMessage } from '@mai/protocol';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from './server';

let server: RunningServer;
afterEach(() => server?.close());

const nextMessage = async (ws: WebSocket) => {
  const [data] = await once(ws, 'message');
  return decode<ServerMessage>(data.toString());
};

test('greets and answers ping with the same id', async () => {
  server = await startServer({ token: 'secret' });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=secret`);
  const hello = nextMessage(ws);
  await once(ws, 'open');
  expect(await hello).toMatchObject({ type: 'hello', daemonVersion: expect.any(String) });

  ws.send(encode({ v: PROTOCOL_VERSION, type: 'ping', id: 'p1', t: 42 }));
  expect(await nextMessage(ws)).toEqual({ v: PROTOCOL_VERSION, type: 'pong', id: 'p1', t: 42 });
  ws.close();
});

test.each([
  ['wrong token', '?token=nope'],
  ['missing token', ''],
])('rejects %s', async (_, query) => {
  server = await startServer({ token: 'secret' });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${query}`);
  const [, res] = await once(ws, 'unexpected-response');
  expect(res.statusCode).toBe(401);
});
