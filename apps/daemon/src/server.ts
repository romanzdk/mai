import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ClientMessage, decode, encode, PROTOCOL_VERSION } from '@mai/protocol';
import { WebSocketServer } from 'ws';
import pkg from '../package.json' with { type: 'json' };

export interface ServerOptions {
  token: string;
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

export function startServer({ token, port = 0 }: ServerOptions): Promise<RunningServer> {
  const startedAt = Date.now();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: ({ req }: { req: IncomingMessage }) => tokenMatches(req.url, token),
  });

  wss.on('connection', (ws) => {
    ws.send(encode({ v: PROTOCOL_VERSION, type: 'hello', daemonVersion: pkg.version, startedAt }));
    ws.on('message', (data) => {
      const msg = decode<ClientMessage>(data.toString());
      if (msg?.type === 'ping') {
        ws.send(encode({ v: PROTOCOL_VERSION, type: 'pong', id: msg.id, t: msg.t }));
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
