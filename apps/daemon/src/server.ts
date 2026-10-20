import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type ClientMessage,
  decode,
  encode,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mai/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import pkg from '../package.json' with { type: 'json' };
import type { Core } from './core';

export interface ServerOptions {
  token: string;
  core: Core;
  port?: number;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

// Any local process or web page can reach 127.0.0.1, so every connection must carry the token
// the Tauri host generated and handed to the UI.
function tokenMatches(url: string | undefined, token: string): boolean {
  const given = Buffer.from(new URL(url ?? '/', 'http://x').searchParams.get('token') ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const MAX_INPUT_CHARS = 20_000;

export function startServer({ token, core, port = 0 }: ServerOptions): Promise<RunningServer> {
  const startedAt = Date.now();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: ({ req }: { req: IncomingMessage }) => tokenMatches(req.url, token),
  });

  wss.on('connection', (ws: WebSocket) => {
    const send = (msg: ServerMessage) => ws.send(encode(msg));
    let unsubscribe: (() => void) | undefined;
    ws.on('close', () => unsubscribe?.());

    send({ v: PROTOCOL_VERSION, type: 'hello', daemonVersion: pkg.version, startedAt });
    send({ v: PROTOCOL_VERSION, type: 'auth', ...core.authState });
    ws.on('message', (data) => {
      const msg = decode<ClientMessage>(data.toString());
      if (!msg) return;
      switch (msg.type) {
        case 'ping':
          send({ v: PROTOCOL_VERSION, type: 'pong', id: msg.id, t: msg.t });
          break;
        case 'subscribe':
          if (unsubscribe) break;
          unsubscribe = core.subscribe(send);
          for (const event of core.store.eventsSince(Number(msg.since) || 0)) {
            send({ v: PROTOCOL_VERSION, type: 'event', event });
          }
          break;
        case 'input':
          if (
            typeof msg.text === 'string' &&
            msg.text.trim() &&
            msg.text.length <= MAX_INPUT_CHARS
          ) {
            void core.handleInput(
              String(msg.inputId),
              msg.text.trim(),
              typeof msg.aboutJobId === 'string' ? msg.aboutJobId : undefined,
            );
          }
          break;
        case 'approve':
          core.decide(String(msg.approvalId), 'approved', 'you', msg.remember === true);
          break;
        case 'deny':
          core.decide(String(msg.approvalId), 'denied', 'you');
          break;
        case 'cancel':
          core.cancel(String(msg.jobId));
          break;
        case 'retry':
          core.retry(String(msg.jobId));
          break;
        case 'dismiss':
          core.dismiss(String(msg.jobId));
          break;
        case 'open_folder':
          core.openFolder(String(msg.jobId));
          break;
        case 'login':
          core.login();
          break;
      }
    });
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () =>
      resolve({
        port: (wss.address() as AddressInfo).port,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      }),
    );
  });
}
