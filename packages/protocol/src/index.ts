export const PROTOCOL_VERSION = 3;

type Msg<T extends string, P = object> = { v: typeof PROTOCOL_VERSION; type: T } & P;

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobSpec {
  title: string;
  prompt: string;
  cwd?: string;
  model?: string;
}

export interface Job {
  id: string;
  title: string;
  spec: JobSpec;
  status: JobStatus;
  model: string;
  cwd: string;
  createdAt: number;
  finishedAt: number | null;
}

export interface Report {
  summary: string;
  changes: string[];
  artifacts: string[];
  needs_you: string[];
}

export type EventBody =
  | { kind: 'user_input'; text: string; inputId: string }
  | { kind: 'desk_reply'; text: string; inputId: string; jobIds: string[] }
  | { kind: 'desk_error'; message: string; inputId: string }
  | { kind: 'job_created'; job: Job; retryOf?: string }
  | { kind: 'job_status'; status: JobStatus; error?: string }
  | { kind: 'job_tool'; tool: string; summary: string }
  | { kind: 'job_text'; text: string }
  | { kind: 'job_report'; report: Report }
  | {
      kind: 'approval_requested';
      approvalId: string;
      ruleId: string;
      tool: string;
      command: string;
      reason: string;
    }
  | {
      kind: 'approval_decided';
      approvalId: string;
      decision: ApprovalDecision;
      by: 'you' | 'remembered' | 'cancel' | 'restart';
      remember?: boolean;
    }
  | { kind: 'inbox_dismissed' };

export type ApprovalDecision = 'approved' | 'denied' | 'expired';

export type MaiEvent = EventBody & { id: number; ts: number; jobId: string | null };

export type ClientMessage =
  | Msg<'ping', { id: string; t: number }>
  | Msg<'subscribe', { since: number }>
  | Msg<'input', { inputId: string; text: string }>
  | Msg<'approve', { approvalId: string; remember: boolean }>
  | Msg<'deny', { approvalId: string }>
  | Msg<'cancel', { jobId: string }>
  | Msg<'retry', { jobId: string }>
  | Msg<'dismiss', { jobId: string }>
  | Msg<'open_folder', { jobId: string }>
  | Msg<'login'>;

export type AuthState = 'checking' | 'logged_in' | 'logged_out' | 'login_started' | 'api_key';

export type ServerMessage =
  | Msg<'hello', { daemonVersion: string; startedAt: number }>
  | Msg<'pong', { id: string; t: number }>
  | Msg<'event', { event: MaiEvent }>
  // Streaming front-desk text; not persisted, the final text arrives as a desk_reply event.
  | Msg<'desk_delta', { inputId: string; text: string }>
  | Msg<'auth', { state: AuthState; detail?: string }>;

export const encode = (msg: ClientMessage | ServerMessage): string => JSON.stringify(msg);

export function decode<M extends ClientMessage | ServerMessage>(raw: string): M | null {
  try {
    const msg = JSON.parse(raw);
    if (msg?.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') return null;
    return msg as M;
  } catch {
    return null;
  }
}
