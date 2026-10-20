import type { Report } from '@mai/protocol';
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

export interface Agent {
  desk(text: string, ctx: DeskContext, onDelta: (visible: string) => void): Promise<DeskResult>;
  runWorker(args: Omit<WorkerArgs, 'apiKeyMode' | 'headedBrowser'>): Promise<WorkerResult>;
  summarize(transcript: string): Promise<Report>;
  authState(): Promise<'logged_in' | 'logged_out' | 'api_key'>;
  openLogin(): void;
  close(): void;
}

export function createAgent({
  apiKeyMode,
  headedBrowser,
}: {
  apiKeyMode: boolean;
  headedBrowser: boolean;
}): Agent {
  const desk = new FrontDesk(apiKeyMode);
  desk.start();
  return {
    desk: (text, ctx, onDelta) => desk.turn(text, ctx, onDelta),
    runWorker: (args) => runWorker({ ...args, apiKeyMode, headedBrowser }),
    summarize: (transcript) => summarize(transcript, apiKeyMode),
    authState: async () => {
      if (apiKeyMode && process.env.ANTHROPIC_API_KEY) return 'api_key';
      return (await isLoggedIn()) ? 'logged_in' : 'logged_out';
    },
    openLogin: openLoginTerminal,
    close: () => desk.close(),
  };
}
