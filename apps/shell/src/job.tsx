import { REMEMBERABLE_RULES } from '@mai/protocol';
import { useEffect, useId, useState } from 'react';
import {
  type ApprovalEvent,
  agentSaid,
  ago,
  clock,
  duration,
  isActive,
  type JobState,
  outsidePaths,
  shortPath,
  statusLabel,
  timelineLine,
} from './derive';
import { type Act, Kbd, keyShortcut } from './ui';

const CONSEQUENCE: Record<string, string> = {
  sudo: 'Runs with full admin rights on this computer.',
  delete: 'Deletes permanently. Nothing goes to the Trash.',
  'find-delete': 'Deletes permanently. Nothing goes to the Trash.',
  'git-push': 'Publishes commits to the remote repository.',
  'git-clean': 'Deletes untracked files for good.',
  'git-reset-hard': 'Throws away uncommitted changes.',
  disk: 'Can erase a whole disk.',
  'web-action': 'May buy, send or submit something on the website.',
  'web-code': 'Runs code inside the web page.',
  'web-upload': 'Sends a file from this computer to the website.',
};

// Gives the user a moment to read before a stray click or key can approve.
const APPROVE_DELAY_MS = 1000;

export function JobRow({
  state,
  now,
  index,
  onOpen,
}: {
  state: JobState;
  now: number;
  index?: number;
  onOpen: () => void;
}) {
  const waiting = state.pendingApprovals[0];
  const stale = state.status === 'running' && now - state.lastTs > 90_000;
  const last = state.timeline.at(-1);
  const line = waiting
    ? `approve: ${waiting.command}`
    : state.status === 'failed' && state.error
      ? state.error
      : stale
        ? `no activity for ${ago(now - state.lastTs)}`
        : (state.report?.summary ??
          (last ? timelineLine(last, state.requested) : 'waiting to start'));
  const time = isActive(state)
    ? ago(now - state.job.createdAt)
    : state.finishedAt
      ? `${ago(now - state.finishedAt)} ago`
      : '';
  const key = index !== undefined && index < 9 ? String(index + 1) : '';
  return (
    <button
      type="button"
      className="job"
      data-status={state.status}
      data-attention={statusLabel(state) === 'needs you'}
      data-stale={stale}
      data-shortcut={key ? `row-${key}` : undefined}
      aria-keyshortcuts={key ? keyShortcut(key) : undefined}
      title={state.job.title}
      onClick={onOpen}
    >
      <span className="job-key" aria-hidden="true">
        {key}
      </span>
      <span className="job-status">{statusLabel(state)}</span>
      <span className="job-title">{state.job.title}</span>
      <span className="job-line">{line}</span>
      <span className="job-time">{time}</span>
    </button>
  );
}

export function ApprovalCard({
  approval,
  job,
  act,
  home,
  now,
  isTarget,
  onOpenJob,
}: {
  approval: ApprovalEvent;
  job: JobState;
  act: Act;
  home: string;
  now: number;
  isTarget: boolean;
  onOpenJob?: () => void;
}) {
  const id = useId();
  const [remember, setRemember] = useState(false);
  const [sent, setSent] = useState<'approve' | 'deny' | null>(null);
  const [notSent, setNotSent] = useState(false);
  const [ready, setReady] = useState(() => Date.now() - approval.ts >= APPROVE_DELAY_MS);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => setReady(true), APPROVE_DELAY_MS - (Date.now() - approval.ts));
    return () => clearTimeout(t);
  }, [ready, approval.ts]);

  const canRemember = REMEMBERABLE_RULES.includes(approval.ruleId);
  const outside = outsidePaths(approval.command, job.job.cwd, home);
  const said = agentSaid(job, approval.approvalId);
  const decide = (type: 'approve' | 'deny') => {
    const ok = act(
      type === 'approve'
        ? { type, approvalId: approval.approvalId, remember: canRemember && remember }
        : { type, approvalId: approval.approvalId },
    );
    setNotSent(!ok);
    if (ok) setSent(type);
  };

  return (
    <section className="approval" aria-labelledby={id} data-testid="approval">
      <div className="approval-head">
        <h3 id={id} className="label">
          needs approval · {approval.reason}
        </h3>
        {onOpenJob && (
          <button type="button" className="link" onClick={onOpenJob}>
            {job.job.title}
          </button>
        )}
        <span className="muted small">waiting {ago(now - approval.ts)}</span>
      </div>
      <dl className="facts">
        <dt>You asked</dt>
        <dd className="clamp">{job.job.spec.prompt}</dd>
        {said && (
          <>
            <dt>Agent says</dt>
            <dd className="clamp">{said}</dd>
          </>
        )}
        <dt>Job folder</dt>
        <dd className="mono">{shortPath(job.job.cwd, home)}</dd>
      </dl>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: long commands must scroll by keyboard */}
      <pre className="command" tabIndex={0}>
        {approval.command}
      </pre>
      {outside.length > 0 && <p className="warn">Outside the job folder: {outside.join(', ')}</p>}
      <p className="consequence">{CONSEQUENCE[approval.ruleId] ?? approval.reason}</p>
      {canRemember && (
        <label className="remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{' '}
          Don't ask again for this kind of action in this job, until mai restarts
        </label>
      )}
      <div className="actions">
        <button
          type="button"
          className="button warn"
          disabled={!ready || sent !== null}
          data-shortcut={isTarget ? 'approve' : undefined}
          aria-keyshortcuts={isTarget ? keyShortcut('Y') : undefined}
          onClick={() => decide('approve')}
        >
          {sent === 'approve'
            ? 'Approving…'
            : canRemember && remember
              ? 'Approve all for this job'
              : 'Approve'}
          {isTarget && <Kbd k="Y" />}
        </button>
        <button
          type="button"
          className="button"
          disabled={sent !== null}
          data-shortcut={isTarget ? 'deny' : undefined}
          aria-keyshortcuts={isTarget ? keyShortcut('N') : undefined}
          onClick={() => decide('deny')}
        >
          {sent === 'deny' ? 'Denying…' : 'Deny and stop job'}
          {isTarget && <Kbd k="N" />}
        </button>
        {notSent && <span className="error">Not connected, nothing was sent.</span>}
      </div>
    </section>
  );
}

function ReportCard({ state, act }: { state: JobState; act: Act }) {
  const r = state.report;
  if (!r) return null;
  const list = (label: string, items: string[]) =>
    items.length > 0 && (
      <div className="report-list">
        <h3 className="label">{label}</h3>
        <ul>
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className="report" data-status={state.status} data-testid="report">
      {r.needs_you.length > 0 && (
        <div className="needs-you-block">
          <h3 className="label">needs you</h3>
          <ul>
            {r.needs_you.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      )}
      <p>{r.summary}</p>
      {list('changes', r.changes)}
      {r.artifacts.length > 0 && (
        <div className="report-list">
          <h3 className="label">artifacts</h3>
          <ul>
            {r.artifacts.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  className="link mono"
                  onClick={() => act({ type: 'open_path', jobId: state.job.id, path })}
                >
                  {path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Timeline({ state }: { state: JobState }) {
  return (
    <ol className="timeline">
      {state.timeline
        .filter((e) => e.kind !== 'job_report')
        .map((e) => (
          <li
            key={e.id}
            data-kind={e.kind}
            data-status={e.kind === 'job_status' ? e.status : undefined}
          >
            <time dateTime={new Date(e.ts).toISOString()}>{clock(e.ts)}</time>
            <span>{e.kind === 'job_text' ? e.text : timelineLine(e, state.requested)}</span>
          </li>
        ))}
    </ol>
  );
}

export function JobView({
  state,
  act,
  now,
  home,
  onBack,
  onOpenJob,
  onRetry,
  onDismiss,
  children,
}: {
  state: JobState;
  act: Act;
  now: number;
  home: string;
  onBack: () => void;
  onOpenJob: (id: string) => void;
  onRetry: () => void;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const id = state.job.id;
  const active = isActive(state);
  const timing = active
    ? duration(now - state.job.createdAt)
    : state.finishedAt
      ? `took ${duration(state.finishedAt - state.job.createdAt)}`
      : '';
  const cwd = shortPath(state.job.cwd, home);
  return (
    <div className="job-view">
      <div className="meta">
        <button type="button" className="link" onClick={onBack} aria-keyshortcuts="Escape">
          ← back{' '}
          <span className="kbd" aria-hidden="true">
            esc
          </span>
        </button>
        <span className="job-status" data-status={state.status}>
          {statusLabel(state)}
        </span>
        <span>{timing}</span>
        <span>started {clock(state.job.createdAt)}</span>
        {state.retryOf && (
          <button type="button" className="link" onClick={() => onOpenJob(state.retryOf as string)}>
            retry of {state.retryOf}
          </button>
        )}
      </div>
      <h1>{state.job.title}</h1>
      <p className="asked">
        <span className="muted">You asked:</span> {state.job.spec.prompt}
      </p>
      <p className="path" title={state.job.cwd}>
        {/* LRM keeps a leading / or ~ in place inside the right-to-left ellipsis box. */}
        <bdi>{`\u200e${cwd}`}</bdi>
        {state.job.branch && <span> · branch {state.job.branch}</span>}
      </p>
      {state.status === 'failed' && (
        <p className="stopped" data-status="failed">
          Stopped: {state.error ?? 'the job failed'}
        </p>
      )}
      {state.status === 'cancelled' && (
        <p className="stopped" data-status="cancelled">
          Cancelled by you.
        </p>
      )}
      <div className="actions">
        {active ? (
          <button
            type="button"
            className="button danger"
            data-shortcut="cancel"
            aria-keyshortcuts={keyShortcut('.')}
            onClick={() => act({ type: 'cancel', jobId: id })}
          >
            Cancel <Kbd k="." />
          </button>
        ) : (
          <button
            type="button"
            className="button"
            data-shortcut="retry"
            aria-keyshortcuts={keyShortcut('R')}
            onClick={onRetry}
          >
            Retry <Kbd k="R" />
          </button>
        )}
        <button
          type="button"
          className="button"
          data-shortcut="open-folder"
          aria-keyshortcuts={keyShortcut('O')}
          onClick={() => act({ type: 'open_folder', jobId: id })}
        >
          Open folder <Kbd k="O" />
        </button>
        {!active && !state.dismissed && (
          <button
            type="button"
            className="button"
            data-shortcut="dismiss"
            aria-keyshortcuts={keyShortcut('D')}
            title={state.job.branch ? 'Also removes the job worktree; the branch stays' : undefined}
            onClick={onDismiss}
          >
            Dismiss <Kbd k="D" />
          </button>
        )}
      </div>
      {state.pendingApprovals.map((a, i) => (
        <ApprovalCard
          key={a.approvalId}
          approval={a}
          job={state}
          act={act}
          home={home}
          now={now}
          isTarget={i === 0}
        />
      ))}
      <ReportCard state={state} act={act} />
      <h2 className="label">steps</h2>
      <Timeline state={state} />
      {children}
    </div>
  );
}
