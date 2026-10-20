import { isTauri } from '@tauri-apps/api/core';

let allowed: Promise<boolean> | undefined;

// Native notification through Tauri; does nothing in a plain browser (tests, Vite dev).
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  const n = await import('@tauri-apps/plugin-notification');
  allowed ??= n
    .isPermissionGranted()
    .then(async (ok) => ok || (await n.requestPermission()) === 'granted')
    .catch(() => false);
  if (await allowed) n.sendNotification({ title, body });
}
