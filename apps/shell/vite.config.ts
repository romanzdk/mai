/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: { include: ['src/**/*.test.ts'] },
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
});
