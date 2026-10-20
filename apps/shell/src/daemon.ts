import {
  type ClientMessage,
  decode,
  encode,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@mai/protocol';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

interface DaemonInfo {
  url: string;
  token: string;
}

export type DaemonState =
  | { status: 'starting' | 'connecting' | 'disconnected' | 'exited' }
  | { status: 'connected'; version: string; startedAt: number; rtt?: number };

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

export function useDaemon(): DaemonState {
  const [state, setState] = useState<DaemonState>({ status: 'starting' });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const unlistenExit = isTauri()
      ? listen('daemon-exit', () => setState({ status: 'exited' }))
      : Promise.resolve(() => {});

    const send = (msg: ClientMessage) => ws?.send(encode(msg));

    const connect = (info: DaemonInfo) => {
      if (stopped) return;
      setState({ status: 'connecting' });
      ws = new WebSocket(`${info.url}/?token=${encodeURIComponent(info.token)}`);
      ws.onmessage = (e) => {
        const msg = decode<ServerMessage>(e.data);
        if (msg?.type === 'hello') {
          setState({ status: 'connected', version: msg.daemonVersion, startedAt: msg.startedAt });
        } else if (msg?.type === 'pong') {
          setState((s) => (s.status === 'connected' ? { ...s, rtt: Date.now() - msg.t } : s));
        }
      };
      ws.onopen = () => {
        pingTimer = setInterval(
          () => send({ v: PROTOCOL_VERSION, type: 'ping', id: crypto.randomUUID(), t: Date.now() }),
          PING_MS,
        );
      };
      ws.onclose = () => {
        clearInterval(pingTimer);
        if (stopped) return;
        setState((s) => (s.status === 'exited' ? s : { status: 'disconnected' }));
        retryTimer = setTimeout(() => connect(info), RECONNECT_MS);
      };
    };

    daemonInfo().then(connect);

    return () => {
      stopped = true;
      clearInterval(pingTimer);
      clearTimeout(retryTimer);
      ws?.close();
      unlistenExit.then((f) => f());
    };
  }, []);

  return state;
}
