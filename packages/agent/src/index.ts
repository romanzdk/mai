import type { Report, Usage } from '@mai/protocol';
import { isLoggedIn, openLoginTerminal } from './auth';
import { type DeskContext, type DeskResult, FrontDesk } from './desk';
import { summarize } from './report';
import { runWorker, type WorkerArgs, type WorkerResult } from './worker';

export { claudeBinary, isLoggedIn, openLoginTerminal } from './auth';
export type { DeskContext, DeskResult } from './desk';
export { parseDeskOutput, visibleReply } from './parse';
export { checkToolUse } from './policy';
export { WORKER_MODEL } from './sdk';
export type { ApprovalRequest, WorkerArgs, WorkerEvent, WorkerResult } from './worker';
export { stoppedBecause } from './worker';

export interface Agent {
  desk(text: string, ctx: DeskContext, onDelta: (visible: string) => void): Promise<DeskResult>;
  runWorker(args: Omit<WorkerArgs, 'apiKeyMode' | 'headedBrowser'>): Promise<WorkerResult>;
  // Settings changed: the next desk turn starts a fresh session with the new model and auth.
  reconfigure(): void;
  summarize(transcript: string): Promise<Report>;
  authState(): Promise<'logged_in' | 'logged_out' | 'api_key'>;
  usage(): Promise<Usage | null>;
  openLogin(): void;
  close(): void;
}

export interface AgentConfig {
  apiKeyMode: boolean;
  headedBrowser: boolean;
  deskModel: string;
}

// Config is read on every call so Settings changes apply without a restart.
export function createAgent(config: () => AgentConfig): Agent {
  const desk = new FrontDesk(config);
  desk.start();
  return {
    desk: (text, ctx, onDelta) => desk.turn(text, ctx, onDelta),
    runWorker: (args) =>
      runWorker({
        ...args,
        apiKeyMode: config().apiKeyMode,
        headedBrowser: config().headedBrowser,
      }),
    summarize: (transcript) => summarize(transcript, config().apiKeyMode),
    authState: async () => {
      if (config().apiKeyMode && process.env.ANTHROPIC_API_KEY) return 'api_key';
      return (await isLoggedIn()) ? 'logged_in' : 'logged_out';
    },
    openLogin: openLoginTerminal,
    usage: () => (config().apiKeyMode ? Promise.resolve(null) : desk.usage()),
    reconfigure: () => desk.close(),
    close: () => desk.close(),
  };
}
