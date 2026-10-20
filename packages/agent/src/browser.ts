import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

// One browser per worker. `--isolated` keeps the profile in memory: jobs never see the user's
// cookies or logins, which also keeps purchases and sending out of reach by default.
export function playwrightServer(outputDir: string, headed: boolean): McpServerConfig {
  const pkg = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
  return {
    type: 'stdio',
    command: process.execPath,
    args: [
      join(dirname(pkg), 'cli.js'),
      '--browser',
      'chromium',
      '--isolated',
      '--output-dir',
      outputDir,
      ...(headed ? [] : ['--headless']),
    ],
  };
}
