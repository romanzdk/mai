import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The Claude Code binary bundled with the Agent SDK, so login works without a global `claude`.
export function claudeBinary(): string {
  const sdkEntry = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`;
  return join(dirname(createRequire(sdkEntry).resolve(pkg)), 'claude');
}

export async function isLoggedIn(): Promise<boolean> {
  const { stdout } = await run(claudeBinary(), ['auth', 'status', '--json'], { timeout: 15_000 });
  return JSON.parse(stdout).loggedIn === true;
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// `claude auth login` wants a real terminal (browser hand-off, code paste), so open the
// system one instead of emulating a TTY in the app.
export function openLoginTerminal(): void {
  const command = `${shellQuote(claudeBinary())} auth login`;
  if (process.platform === 'darwin') {
    const script = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    spawn(
      'osascript',
      [
        '-e',
        `tell application "Terminal" to do script "${script}"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
      { stdio: 'ignore', detached: true },
    ).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', 'sh', '-c', command], {
      stdio: 'ignore',
      detached: true,
    }).unref();
  }
}
