import {
  type AuthState,
  type ClientMessage,
  decode,
  encode,
  type MaiEvent,
  PROTOCOL_VERSION,
  type Schedule,
  type ServerMessage,
  type Settings,
  type Usage,
} from '@mai/protocol';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DaemonInfo {
  url: string;
  token: string;
}

export type Connection =
  | { status: 'starting' | 'connecting' | 'disconnected' | 'exited'; since: number }
  | { status: 'connected'; since: number; version: string; startedAt: number; rtt?: number };

// Client messages other than the connection plumbing, without the version field.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type Action = DistributiveOmit<
  Exclude<ClientMessage, { type: 'ping' | 'subscribe' | 'input' }>,
  'v'
>;

export interface Daemon {
  connection: Connection;
  home: string;
  events: MaiEvent[];
  // Live front-desk text by inputId, until its desk_reply event lands.
  deltas: Record<string, string>;
  // Inputs not yet echoed back as user_input events; `queued` ones wait for a connection.
  pending: {
    inputId: string;
    text: string;
    aboutJobId?: string;
    sentAt: number;
    queued: boolean;
  }[];
  auth: { state: AuthState; detail?: string };
  usage: Usage | null;
  settings: Settings | null;
  // Why new jobs are on hold, or null.
  paused: string | null;
  schedules: Schedule[];
  // Requests queue until connected, so nothing typed or dictated is lost. Actions do not:
  // a late approve could act on stale state, so act returns false when it sent nothing.
  send: (text: string, aboutJobId?: string) => void;
  act: (msg: Action) => boolean;
  restart: () => void;
}

const PING_MS = 2000;
const RECONNECT_MS = 1000;

export const setAttention = (count: number) => {
  if (isTauri()) void invoke('set_attention', { count }).catch(() => {});
};

export function useDaemon(): Daemon {
  const [connection, setConnection] = useState<Connection>({
    status: 'starting',
    since: Date.now(),
  });
  const [home, setHome] = useState('');
  const [events, setEvents] = useState<MaiEvent[]>([]);
  const [deltas, setDeltas] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Daemon['pending']>([]);
  const [auth, setAuth] = useState<{ state: AuthState; detail?: string }>({ state: 'checking' });
  const [usage, setUsage] = useState<Usage | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const lastId = useRef(0);
  const outbox = useRef<ClientMessage[]>([]);

  useEffect(() => {
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let info: DaemonInfo | undefined;
    const status = (s: Exclude<Connection['status'], 'connected'>) =>
      setConnection((c) => (c.status === s ? c : { status: s, since: Date.now() }));

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

    const connect = () => {
      if (stopped || !info) return;
      clearTimeout(retryTimer);
      status('connecting');
      const ws = new WebSocket(`${info.url}/?token=${encodeURIComponent(info.token)}`);
      wsRef.current = ws;
      const send = (msg: ClientMessage) => ws.send(encode(msg));
      ws.onmessage = (e) => {
        const msg = decode<ServerMessage>(e.data);
        if (msg?.type === 'hello') {
          setHome(msg.home);
          setConnection({
            status: 'connected',
            since: Date.now(),
            version: msg.daemonVersion,
            startedAt: msg.startedAt,
          });
        } else if (msg?.type === 'pong') {
          setConnection((s) => (s.status === 'connected' ? { ...s, rtt: Date.now() - msg.t } : s));
        } else if (msg?.type === 'event') {
          onEvent(msg.event);
        } else if (msg?.type === 'desk_delta') {
          setDeltas((d) => ({ ...d, [msg.inputId]: msg.text }));
        } else if (msg?.type === 'usage') {
          setUsage(msg.usage);
        } else if (msg?.type === 'settings') {
          setSettings(msg.settings);
        } else if (msg?.type === 'scheduler') {
          setPaused(msg.paused);
        } else if (msg?.type === 'schedules') {
          setSchedules(msg.schedules);
        } else if (msg?.type === 'auth') {
          setAuth({ state: msg.state, ...(msg.detail ? { detail: msg.detail } : {}) });
        }
      };
      ws.onopen = () => {
        send({ v: PROTOCOL_VERSION, type: 'subscribe', since: lastId.current });
        const queued = outbox.current.splice(0);
        for (const msg of queued) send(msg);
        if (queued.length) setPending((p) => p.map((x) => ({ ...x, queued: false })));
        pingTimer = setInterval(
          () => send({ v: PROTOCOL_VERSION, type: 'ping', id: crypto.randomUUID(), t: Date.now() }),
          PING_MS,
        );
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped || wsRef.current) return;
        setConnection((s) =>
          s.status === 'exited' ? s : { status: 'disconnected', since: Date.now() },
        );
        retryTimer = setTimeout(connect, RECONNECT_MS);
      };
    };

    // A restarted daemon listens on a new port with a new token, so every ready event
    // replaces the connection.
    const use = (next: DaemonInfo) => {
      if (info?.url === next.url && info.token === next.token) return;
      info = next;
      const old = wsRef.current;
      wsRef.current = null;
      old?.close();
      connect();
    };

    const unlisten: Promise<() => void>[] = [];
    if (isTauri()) {
      unlisten.push(listen<DaemonInfo>('daemon-ready', (e) => use(e.payload)));
      unlisten.push(
        listen('daemon-exit', () => {
          clearTimeout(retryTimer);
          setConnection({ status: 'exited', since: Date.now() });
        }),
      );
      void invoke<DaemonInfo | null>('daemon_info').then((i) => i && use(i));
    } else {
      use({ url: import.meta.env.VITE_MAI_DAEMON_URL, token: import.meta.env.VITE_MAI_TOKEN });
    }

    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      wsRef.current?.close();
      for (const u of unlisten) void u.then((f) => f());
    };
  }, []);

  const act = useCallback((msg: Action) => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(encode({ v: PROTOCOL_VERSION, ...msg } as ClientMessage));
    return true;
  }, []);

  const send = useCallback((text: string, aboutJobId?: string) => {
    const inputId = crypto.randomUUID();
    const msg: ClientMessage = {
      v: PROTOCOL_VERSION,
      type: 'input',
      inputId,
      text,
      ...(aboutJobId ? { aboutJobId } : {}),
    };
    const ws = wsRef.current;
    const open = ws?.readyState === WebSocket.OPEN;
    if (open) ws.send(encode(msg));
    else outbox.current.push(msg);
    setPending((p) => [
      ...p,
      { inputId, text, sentAt: Date.now(), queued: !open, ...(aboutJobId ? { aboutJobId } : {}) },
    ]);
  }, []);

  const restart = useCallback(() => {
    setConnection({ status: 'starting', since: Date.now() });
    if (isTauri()) void invoke('restart_daemon').catch(() => {});
  }, []);

  return {
    connection,
    home,
    events,
    deltas,
    pending,
    auth,
    usage,
    settings,
    paused,
    schedules,
    send,
    act,
    restart,
  };
}
