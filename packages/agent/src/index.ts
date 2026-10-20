import type { Report } from '@mai/protocol';
import { type DeskContext, type DeskResult, FrontDesk } from './desk';
import { summarize } from './report';
import { runWorker, type WorkerArgs, type WorkerResult } from './worker';

export type { DeskContext, DeskResult } from './desk';
export { parseDeskOutput, visibleReply } from './parse';
export { checkToolUse } from './policy';
export { WORKER_MODEL } from './sdk';
export type { WorkerArgs, WorkerEvent, WorkerResult } from './worker';

export interface Agent {
  desk(text: string, ctx: DeskContext, onDelta: (visible: string) => void): Promise<DeskResult>;
  runWorker(args: Omit<WorkerArgs, 'apiKeyMode'>): Promise<WorkerResult>;
  summarize(transcript: string): Promise<Report>;
  close(): void;
}

export function createAgent({ apiKeyMode }: { apiKeyMode: boolean }): Agent {
  const desk = new FrontDesk(apiKeyMode);
  desk.start();
  return {
    desk: (text, ctx, onDelta) => desk.turn(text, ctx, onDelta),
    runWorker: (args) => runWorker({ ...args, apiKeyMode }),
    summarize: (transcript) => summarize(transcript, apiKeyMode),
    close: () => desk.close(),
  };
}
