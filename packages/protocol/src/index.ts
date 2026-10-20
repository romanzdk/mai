export const PROTOCOL_VERSION = 1;

type Msg<T extends string, P = object> = { v: typeof PROTOCOL_VERSION; type: T } & P;

export type ClientMessage = Msg<'ping', { id: string; t: number }>;

export type ServerMessage =
  | Msg<'hello', { daemonVersion: string; startedAt: number }>
  | Msg<'pong', { id: string; t: number }>;

export const encode = (msg: ClientMessage | ServerMessage): string => JSON.stringify(msg);

export function decode<M extends ClientMessage | ServerMessage>(raw: string): M | null {
  try {
    const msg = JSON.parse(raw);
    if (msg?.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') return null;
    return msg as M;
  } catch {
    return null;
  }
}
