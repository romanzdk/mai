import { tmpdir } from 'node:os';
import { defineConfig } from '@playwright/test';

// Tauri's WebView has no Playwright driver on macOS, so e2e drives the same React app in Chromium
// against a real daemon running the fake agent (no model calls). The Rust host is covered by
// cargo tests.
const PORT = 47817;
const TOKEN = 'e2e-token';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:1420' },
  webServer: [
    {
      command: 'node ../daemon/dist/daemon.mjs',
      env: {
        MAI_TOKEN: TOKEN,
        MAI_PORT: String(PORT),
        MAI_FAKE_AGENT: '1',
        MAI_DB: ':memory:',
        MAI_WORKSPACE: tmpdir(),
      },
      port: PORT,
    },
    {
      command: 'vite',
      url: 'http://localhost:1420',
      env: { VITE_MAI_DAEMON_URL: `ws://127.0.0.1:${PORT}`, VITE_MAI_TOKEN: TOKEN },
      reuseExistingServer: false,
    },
  ],
});
