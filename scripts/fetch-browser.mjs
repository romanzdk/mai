// Installs the Chromium build that the workers' Playwright MCP server drives.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.env.CI) process.exit(0);
const mcp = createRequire(new URL('../packages/agent/package.json', import.meta.url)).resolve(
  '@playwright/mcp/package.json',
);
const playwright = dirname(createRequire(mcp).resolve('playwright/package.json'));
execFileSync(process.execPath, [join(playwright, 'cli.js'), 'install', 'chromium'], {
  stdio: 'inherit',
});
