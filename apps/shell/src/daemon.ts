import {
  type ClientMessage,
  decode,
  encode,
  type MaiEvent,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mai/protocol';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DaemonInfo {
  url: string;
  token: string;
}

export type Connection =
  | { status: 'starting' | 'connecting' | 'disconnected' | 'exited' }
  | { status: 'connected'; version: string; startedAt: number; rtt?: number };

export interface Daemon {
  connection: Connection;
  events: MaiEvent[];
  // Live front-desk text by inputId, until its desk_reply event lands.
  deltas: Record<string, string>;
  // Inputs sent but not yet echoed back as user_input events.
  pending: { inputId: string; text: string }[];
  send: (text: string) => void;
}

const PING_MS = 2000;
const RECONNECT_MS = 1000;

async function daemonInfo(): Promise<DaemonInfo> {
  if (!isTauri()) {
    return { url: import.meta.env.VITE_MAI_DAEMON_URL, token: import.meta.env.VITE_MAI_TOKEN };
  }
  // Subscribe before asking, so a ready event between the two calls is not lost.
  let resolveReady: (info: DaemonInfo) => void = () => {};
  const ready = new Promise<DaemonInfo>((r) => {
    resolveReady = r;
  });
  const unlisten = await listen<DaemonInfo>('daemon-ready', (e) => resolveReady(e.payload));
  const info = await invoke<DaemonInfo | null>('daemon_info');
  if (info) resolveReady(info);
  return ready.finally(unlisten);
}

export function useDaemon(): Daemon {
  const [connection, setConnection] = useState<Connection>({ status: 'starting' });
  const [events, setEvents] = useState<MaiEvent[]>([]);
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ inputId: string; text: string }[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const lastId = useRef(0);

  useEffect(() => {
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const unlistenExit = isTauri()
      ? listen('daemon-exit', () => setConnection({ status: 'exited' }))
      : Promise.resolve(() => {});

    const onEvent = (event: MaiEvent) => {
      if (event.id <= lastId.current) return;
      lastId.current = event.id;
      setEvents((prev) => [...prev, event]);
      if (event.kind === 'user_input') {
        setPending((p) => p.filter((x) => x.inputId !== event.inputId));
      } else if (event.kind === 'desk_reply' || event.kind === 'desk_error') {
        setDeltas(({ [event.inputId]: _, ...rest }) => rest);
      }
    };

    const connect = (info: DaemonInfo) => {
      if (stopped) return;
      setConnection({ status: 'connecting' });
      const ws = new WebSocket(`${info.url}/?token=${encodeURIComponent(info.token)}`);
      wsRef.current = ws;
      const send = (msg: ClientMessage) => ws.send(encode(msg));
      ws.onmessage = (e) => {
        const msg = decode<ServerMessage>(e.data);
        if (msg?.type === 'hello') {
          setConnection({
            status: 'connected',
            version: msg.daemonVersion,
            startedAt: msg.startedAt,
          });
        } else if (msg?.type === 'pong') {
          setConnection((s) => (s.status === 'connected' ? { ...s, rtt: Date.now() - msg.t } : s));
        } else if (msg?.type === 'event') {
          onEvent(msg.event);
        } else if (msg?.type === 'desk_delta') {
          setDeltas((d) => ({ ...d, [msg.inputId]: msg.text }));
        }
      };
      ws.onopen = () => {
        send({ v: PROTOCOL_VERSION, type: 'subscribe', since: lastId.current });
        pingTimer = setInterval(
          () => send({ v: PROTOCOL_VERSION, type: 'ping', id: crypto.randomUUID(), t: Date.now() }),
          PING_MS,
        );
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        wsRef.current = null;
        if (stopped) return;
        setConnection((s) => (s.status === 'exited' ? s : { status: 'disconnected' }));
        retryTimer = setTimeout(() => connect(info), RECONNECT_MS);
      };
    };

    daemonInfo().then(connect);

    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      wsRef.current?.close();
      unlistenExit.then((f) => f());
    };
  }, []);

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const inputId = crypto.randomUUID();
    setPending((p) => [...p, { inputId, text }]);
    ws.send(encode({ v: PROTOCOL_VERSION, type: 'input', inputId, text }));
  }, []);

  return { connection, events, deltas, pending, send };
}
