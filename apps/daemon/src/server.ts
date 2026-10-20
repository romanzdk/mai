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
    ws.on('message', (data) => {
      const msg = decode<ClientMessage>(data.toString());
      if (msg?.type === 'ping') {
        send({ v: PROTOCOL_VERSION, type: 'pong', id: msg.id, t: msg.t });
      } else if (msg?.type === 'subscribe' && !unsubscribe) {
        unsubscribe = core.subscribe(send);
        for (const event of core.store.eventsSince(msg.since)) {
          send({ v: PROTOCOL_VERSION, type: 'event', event });
        }
      } else if (
        msg?.type === 'input' &&
        typeof msg.text === 'string' &&
        msg.text.trim() &&
        msg.text.length <= MAX_INPUT_CHARS
      ) {
        void core.handleInput(String(msg.inputId), msg.text.trim());
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
