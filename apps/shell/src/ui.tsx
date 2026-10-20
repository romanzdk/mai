import { useEffect, useState } from 'react';
import type { Action } from './daemon';

export type Act = (msg: Action) => boolean;

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
export const isMod = (e: KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey);
export const keyShortcut = (key: string) => `${IS_MAC ? 'Meta' : 'Control'}+${key}`;

// Shortcuts click the visible element with this data-shortcut, so a key does exactly what
// the button does (including being disabled).
export const SHORTCUT_KEYS: Record<string, string> = {
  y: 'approve',
  n: 'deny',
  i: 'inbox',
  f: 'history',
  '.': 'cancel',
  r: 'retry',
  o: 'open-folder',
  d: 'dismiss',
};

export function Kbd({ k }: { k: string }) {
  return (
    <span className="kbd" aria-hidden="true">
      {MOD}
      {k}
    </span>
  );
}

export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
