import { spawn } from 'node:child_process';
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

// Downloads the Chromium build the MCP server drives, if it is missing. Quick when present.
export function ensureBrowser(onDownloading: () => void): Promise<void> {
  const mcp = createRequire(import.meta.url).resolve('@playwright/mcp/package.json');
  const cli = join(dirname(createRequire(mcp).resolve('playwright/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      if (/download/i.test(text)) onDownloading();
      tail = (tail + text).slice(-400);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(tail.trim().split('\n').at(-1) || `exit ${code}`)),
    );
  });
}
