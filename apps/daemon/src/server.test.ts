import { once } from 'node:events';
import { tmpdir } from 'node:os';
import {
  type ClientMessage,
  decode,
  encode,
  type MaiEvent,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mai/protocol';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { Core } from './core';
import { createFakeAgent } from './fake-agent';
import { type RunningServer, startServer } from './server';
import { Store } from './store';

let server: RunningServer;
afterEach(() => server?.close());

const start = async () => {
  const core = new Core({
    store: new Store(':memory:'),
    agent: createFakeAgent(),
    workspace: tmpdir(),
    home: tmpdir(),
    maxParallel: 2,
  });
  server = await startServer({ token: 'secret', core });
  return core;
};

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/?token=secret`);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => {
    const msg = decode<ServerMessage>(d.toString());
    if (msg) messages.push(msg);
  });
  await once(ws, 'open');
  const send = (m: ClientMessage) => ws.send(encode(m));
  const events = () => messages.flatMap((m) => (m.type === 'event' ? [m.event] : [])) as MaiEvent[];
  const waitFor = async (pred: (e: MaiEvent[]) => boolean) => {
    for (let i = 0; i < 200 && !pred(events()); i++) await new Promise((r) => setTimeout(r, 10));
    return events();
  };
  return { ws, messages, send, events, waitFor };
}

test('greets and answers ping with the same id', async () => {
  await start();
  const c = await connect();
  c.send({ v: PROTOCOL_VERSION, type: 'ping', id: 'p1', t: 42 });
  await new Promise((r) => setTimeout(r, 50));
  expect(c.messages[0]).toMatchObject({ type: 'hello', daemonVersion: expect.any(String) });
  expect(c.messages).toContainEqual({ v: PROTOCOL_VERSION, type: 'pong', id: 'p1', t: 42 });
  c.ws.close();
});

test.each([
  ['wrong token', '?token=nope'],
  ['missing token', ''],
])('rejects %s', async (_, query) => {
  await start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/${query}`);
  const [, res] = await once(ws, 'unexpected-response');
  expect(res.statusCode).toBe(401);
});

test('a question is acknowledged at once and answered by the desk', async () => {
  await start();
  const c = await connect();
  c.send({ v: PROTOCOL_VERSION, type: 'subscribe', since: 0 });
  c.send({ v: PROTOCOL_VERSION, type: 'input', inputId: 'i1', text: 'hello' });
  const events = await c.waitFor((e) => e.some((x) => x.kind === 'desk_reply'));
  expect(events.map((e) => e.kind)).toEqual(['user_input', 'desk_reply']);
  expect(events[1]).toMatchObject({ text: 'echo: hello', inputId: 'i1', jobIds: [] });
  expect(c.messages).toContainEqual(expect.objectContaining({ type: 'desk_delta', inputId: 'i1' }));
  c.ws.close();
});

test('a dispatched job runs, reports, and replays to a late subscriber', async () => {
  const core = await start();
  const c = await connect();
  c.send({ v: PROTOCOL_VERSION, type: 'subscribe', since: 0 });
  c.send({ v: PROTOCOL_VERSION, type: 'input', inputId: 'i1', text: 'do a job' });
  const events = await c.waitFor((e) =>
    e.some((x) => x.kind === 'job_status' && x.status === 'done'),
  );
  expect(events.map((e) => (e.kind === 'job_status' ? `status:${e.status}` : e.kind))).toEqual([
    'user_input',
    'desk_reply',
    'job_created',
    'status:running',
    'job_tool',
    'job_text',
    'job_report',
    'status:done',
  ]);
  const jobId = events.find((e) => e.kind === 'job_created')?.jobId;
  expect(core.store.jobs()).toMatchObject([{ id: jobId, status: 'done' }]);
  expect(core.store.recentReports(5)).toMatchObject([
    { jobId, report: { summary: 'Fake report.' } },
  ]);

  const late = await connect();
  late.send({ v: PROTOCOL_VERSION, type: 'subscribe', since: 2 });
  const replay = await late.waitFor((e) => e.length >= events.length - 2);
  expect(replay.map((e) => e.id)).toEqual(events.slice(2).map((e) => e.id));
  c.ws.close();
  late.ws.close();
});

test('oversized and empty input is ignored', async () => {
  await start();
  const c = await connect();
  c.send({ v: PROTOCOL_VERSION, type: 'subscribe', since: 0 });
  c.send({ v: PROTOCOL_VERSION, type: 'input', inputId: 'a', text: '   ' });
  c.send({ v: PROTOCOL_VERSION, type: 'input', inputId: 'b', text: 'x'.repeat(20_001) });
  await new Promise((r) => setTimeout(r, 50));
  expect(c.events()).toEqual([]);
  c.ws.close();
});
