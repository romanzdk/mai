export const PROTOCOL_VERSION = 7;

// Rules whose approval may be remembered for the rest of a job. Never the ones that can lose
// data or money: one remembered delete would silently allow any later delete in that job.
export const REMEMBERABLE_RULES = ['git-push', 'web-code'];

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
  // Git project jobs run in a worktree (cwd) of `project` on `branch`.
  project?: string;
  branch?: string;
}

export interface Report {
  summary: string;
  changes: string[];
  artifacts: string[];
  needs_you: string[];
}

export type EventBody =
  | { kind: 'user_input'; text: string; inputId: string; aboutJobId?: string }
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

// Claude plan limits, as Claude Code's /usage reports them. Null when they do not apply
// (API-key mode) or could not be read.
export interface UsageWindow {
  pct: number | null;
  resetsAt: string | null;
}

export interface Usage {
  fiveHour?: UsageWindow;
  week?: UsageWindow;
  models: (UsageWindow & { name: string })[];
  // Paid extra usage beyond the plan, only when it has a real monthly limit.
  credits?: { used: number; limit: number; currency: string };
  checkedAt: number;
}

export interface Settings {
  deskModel: string;
  workerModel: string;
  maxParallel: number;
  workspace: string;
  // Off by default: subscription billing through `claude login`.
  apiKeyMode: boolean;
  browserHeaded: boolean;
  jobMaxTurns: number;
  // 0 means no cap. API-equivalent dollars, as the SDK reports them.
  jobMaxCostUsd: number;
  // A running job with no new step for this long is stopped as hung.
  jobIdleMinutes: number;
  // New jobs wait while a plan window is at or above this; 100 or more means never.
  pauseAtUsagePct: number;
  notifications: boolean;
}

export const DEFAULT_SETTINGS: Omit<Settings, 'workspace'> = {
  deskModel: 'claude-haiku-5-5',
  workerModel: 'claude-opus-5-5',
  maxParallel: 2,
  apiKeyMode: false,
  browserHeaded: false,
  jobMaxTurns: 200,
  jobMaxCostUsd: 20,
  jobIdleMinutes: 30,
  pauseAtUsagePct: 95,
  notifications: true,
};

const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  maxParallel: [1, 8],
  jobMaxTurns: [10, 5000],
  jobMaxCostUsd: [0, 1000],
  jobIdleMinutes: [1, 480],
  pauseAtUsagePct: [10, 100],
};

// Applies a patch from the UI, keeping only known keys with the right type and range.
export function applySettings(current: Settings, patch: unknown): Settings {
  const next = { ...current };
  if (typeof patch !== 'object' || patch === null) return next;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in current)) continue;
    const k = key as keyof Settings;
    const kind = typeof current[k];
    if (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) {
      const [lo, hi] = RANGES[k] ?? [-Infinity, Infinity];
      (next as Record<string, unknown>)[k] = Math.min(hi, Math.max(lo, Math.round(value)));
    } else if (kind === 'boolean' && typeof value === 'boolean') {
      (next as Record<string, unknown>)[k] = value;
    } else if (kind === 'string' && typeof value === 'string' && value.trim()) {
      if (k === 'workspace' && !value.trim().startsWith('/')) continue;
      (next as Record<string, unknown>)[k] = value.trim();
    }
  }
  return next;
}

export type ApprovalDecision = 'approved' | 'denied' | 'expired';

export type MaiEvent = EventBody & { id: number; ts: number; jobId: string | null };

export type ClientMessage =
  | Msg<'ping', { id: string; t: number }>
  | Msg<'subscribe', { since: number }>
  | Msg<'input', { inputId: string; text: string; aboutJobId?: string }>
  | Msg<'approve', { approvalId: string; remember: boolean }>
  | Msg<'deny', { approvalId: string }>
  | Msg<'cancel', { jobId: string }>
  | Msg<'retry', { jobId: string }>
  | Msg<'dismiss', { jobId: string }>
  | Msg<'open_folder', { jobId: string }>
  | Msg<'open_path', { jobId: string; path: string }>
  | Msg<'set_settings', { patch: Partial<Settings> }>
  | Msg<'resume_anyway'>
  | Msg<'login'>;

export type AuthState = 'checking' | 'logged_in' | 'logged_out' | 'login_started' | 'api_key';

export type ServerMessage =
  | Msg<'hello', { daemonVersion: string; startedAt: number; home: string }>
  | Msg<'pong', { id: string; t: number }>
  | Msg<'event', { event: MaiEvent }>
  // Streaming front-desk text; not persisted, the final text arrives as a desk_reply event.
  | Msg<'desk_delta', { inputId: string; text: string }>
  | Msg<'auth', { state: AuthState; detail?: string }>
  | Msg<'usage', { usage: Usage | null }>
  | Msg<'settings', { settings: Settings }>
  // Why new jobs are not starting right now, or null when they start normally.
  | Msg<'scheduler', { paused: string | null }>;

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
