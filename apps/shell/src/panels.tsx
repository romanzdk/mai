import type { AuthState, Usage, UsageWindow } from '@mai/protocol';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { Connection } from './daemon';
import {
  type ApprovalEvent,
  ago,
  type Exchange,
  type JobCounts,
  type JobState,
  resetLabel,
  searchJobs,
  usageLevel,
} from './derive';
import { ApprovalCard, JobRow } from './job';
import { type Act, Kbd, keyShortcut } from './ui';

function UsageMeter({
  label,
  name,
  w,
  now,
  extra = '',
}: {
  label: string;
  name: string;
  w: UsageWindow;
  now: number;
  extra?: string;
}) {
  const pct = w.pct ?? 0;
  const resets = w.resetsAt ? resetLabel(w.resetsAt, now) : '';
  return (
    <span
      className="meter"
      data-level={usageLevel(w.pct)}
      title={`${name}: ${w.pct ?? '?'}% used${resets ? `, resets ${resets}` : ''}${extra}`}
    >
      <span className="meter-label">{label}</span>
      <span className="meter-bar" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="meter-value">{w.pct === null ? '?' : `${Math.round(pct)}%`}</span>
      {resets && <span className="meter-reset">↻ {resets}</span>}
    </span>
  );
}

export function TopBar({
  connection,
  inboxCount,
  counts,
  usage,
  now,
  onInbox,
  onHistory,
}: {
  connection: Connection;
  inboxCount: number;
  counts: JobCounts;
  usage: Usage | null;
  now: number;
  onInbox: () => void;
  onHistory: () => void;
}) {
  const busy = [
    counts.running > 0 && { k: 'running', text: `${counts.running} running` },
    counts.queued > 0 && { k: 'queued', text: `${counts.queued} queued` },
    counts.needsYou > 0 && { k: 'needs-you', text: `${counts.needsYou} needs you` },
  ].filter((x): x is { k: string; text: string } => Boolean(x));
  const clockDate = new Date(now);
  const ok = connection.status === 'connected';
  const details =
    connection.status === 'connected'
      ? `daemon v${connection.version}, up ${ago(Date.now() - connection.startedAt)}${
          connection.rtt !== undefined ? `, rtt ${connection.rtt} ms` : ''
        }`
      : `daemon ${connection.status}`;
  return (
    <header className="topbar" data-testid="daemon-status">
      <span className="brand" title={details}>
        <span className="logo" aria-hidden="true" />
        mai
        <span className="dot" data-state={connection.status} aria-hidden="true" />
        {!ok && <span className="error"> · daemon {connection.status}</span>}
        <span className="sr-only">{ok ? ' daemon connected' : ''}</span>
      </span>
      <span className="jobs-summary" data-testid="job-counts">
        {busy.length === 0 ? (
          <span className="muted">idle</span>
        ) : (
          busy.map((b) => (
            <span key={b.k} className="count-chip" data-kind={b.k}>
              {b.text}
            </span>
          ))
        )}
      </span>
      <span className="topbar-spacer" />
      {usage && (
        <span className="usage" data-testid="usage">
          <span className="sr-only">Claude plan usage: </span>
          {usage.fiveHour && (
            <UsageMeter label="5h" name="5-hour limit" w={usage.fiveHour} now={now} />
          )}
          {usage.week && (
            <UsageMeter
              label="week"
              name="Weekly limit"
              w={usage.week}
              now={now}
              extra={usage.models
                .map((m) => `\n${m.name}: ${m.pct ?? '?'}% of its weekly limit`)
                .join('')}
            />
          )}
          {usage.credits && (
            <span className="meter" title="Extra usage credits this month">
              <span className="meter-label">credits</span>
              <span className="meter-value">
                {usage.credits.used.toFixed(2)} / {usage.credits.limit} {usage.credits.currency}
              </span>
            </span>
          )}
        </span>
      )}
      <time className="clock" dateTime={clockDate.toISOString()}>
        <span className="clock-date">
          {clockDate.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>{' '}
        {clockDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
      </time>
      <nav className="topbar-links">
        <button
          type="button"
          className="link"
          data-shortcut="history"
          aria-keyshortcuts={keyShortcut('F')}
          onClick={onHistory}
        >
          history <Kbd k="F" />
        </button>
        <button
          type="button"
          className="link"
          data-shortcut="inbox"
          data-attention={inboxCount > 0}
          aria-keyshortcuts={keyShortcut('I')}
          onClick={onInbox}
        >
          inbox
          {inboxCount > 0 && (
            <>
              {' '}
              <span className="count">{inboxCount}</span>
            </>
          )}{' '}
          <Kbd k="I" />
        </button>
      </nav>
    </header>
  );
}

export function Notices({
  connection,
  now,
  auth,
  act,
  restart,
  approvals,
  showApprovalStrip,
  onInbox,
}: {
  connection: Connection;
  now: number;
  auth: { state: AuthState; detail?: string };
  act: Act;
  restart: () => void;
  approvals: { approval: ApprovalEvent; job: JobState }[];
  showApprovalStrip: boolean;
  onInbox: () => void;
}) {
  const since = now - connection.since;
  return (
    <div className="notices">
      {connection.status === 'exited' && (
        <div className="banner danger" role="alert">
          <span>
            mai's background service stopped. Running jobs were interrupted and waiting approvals
            expired.
          </span>
          <button type="button" className="button" onClick={restart}>
            Restart
          </button>
        </div>
      )}
      {connection.status === 'disconnected' && since > 2000 && (
        <div className="banner danger">
          Lost connection to mai's background service. Reconnecting… Buttons won't work until it's
          back.
        </div>
      )}
      {(connection.status === 'starting' || connection.status === 'connecting') && since > 5000 && (
        <div className="banner">Starting mai…</div>
      )}
      {auth.state === 'logged_out' && (
        <div className="banner" data-testid="login">
          <span>
            Not signed in to Claude, so jobs can't start
            {auth.detail ? ` (${auth.detail})` : ''}.
          </span>
          <button type="button" className="button warn" onClick={() => act({ type: 'login' })}>
            Sign in
          </button>
        </div>
      )}
      {auth.state === 'login_started' && (
        <div className="banner" data-testid="login">
          Finish signing in in the Terminal window. This updates by itself.
        </div>
      )}
      {showApprovalStrip && approvals[0] && (
        <div className="banner">
          <span>
            {approvals.length === 1
              ? '1 approval waiting'
              : `${approvals.length} approvals waiting`}{' '}
            · {approvals[0].job.job.title}
          </span>
          <button type="button" className="button warn" onClick={onInbox}>
            Review <Kbd k="I" />
          </button>
        </div>
      )}
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="empty">
      <span className="logo logo-lg" aria-hidden="true" />
      <p>Type what you want done. Jobs run in the background and report back here.</p>
      <p className="muted">
        Deleting files outside a job's folder, sudo, git push, and buying or sending things on
        websites always stop and ask you first.
      </p>
    </div>
  );
}

function thinking(ms: number): string {
  if (ms > 20_000) return 'still waiting for the front desk…';
  if (ms > 3000) return `thinking ${Math.round(ms / 1000)}s`;
  return 'thinking…';
}

export function Conversation({
  exchanges,
  deltas,
  pending,
  jobs,
  now,
  onOpenJob,
}: {
  exchanges: Exchange[];
  deltas: Record<string, string>;
  pending: { inputId: string; text: string; sentAt: number; queued: boolean }[];
  jobs: Map<string, JobState>;
  now: number;
  onOpenJob: (id: string) => void;
}) {
  const queued = new Set(pending.filter((p) => p.queued).map((p) => p.inputId));
  const items = [
    ...exchanges,
    ...pending.map(
      (p): Exchange => ({ inputId: p.inputId, text: p.text, ts: p.sentAt, jobIds: [] }),
    ),
  ];
  if (items.length === 0) return null;
  return (
    <div className="conversation" data-testid="conversation">
      {items.map((ex) => (
        <div key={ex.inputId} className="exchange">
          <div className="you">
            <span className="sr-only">You: </span>
            {ex.text}
          </div>
          <div className="desk">
            <span className="sr-only">mai: </span>
            {ex.error ? (
              <span className="error">{ex.error}</span>
            ) : (
              (ex.reply ??
              deltas[ex.inputId] ?? (
                <span className="muted">
                  {queued.has(ex.inputId)
                    ? 'not sent yet, waiting for mai to connect…'
                    : thinking(now - ex.ts)}
                </span>
              ))
            )}
            {ex.jobIds.map((id) => {
              const job = jobs.get(id);
              return (
                <button
                  key={id}
                  type="button"
                  className="link started"
                  onClick={() => onOpenJob(id)}
                >
                  → started: {job?.job.title ?? id}
                  {job ? ` (${job.status.replace('_', ' ')})` : ''}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function InputBar({
  inputRef,
  onSend,
  about,
  placeholder,
  history,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: (text: string) => void;
  about?: string;
  placeholder: string;
  history: string[];
}) {
  const [text, setText] = useState('');
  // -1 is the draft being typed; 0.. walks back through earlier requests.
  const recall = useRef({ index: -1, draft: '' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, inputRef]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
    recall.current = { index: -1, draft: '' };
  };

  const step = (by: number) => {
    const r = recall.current;
    const next = Math.min(history.length - 1, Math.max(-1, r.index + by));
    if (next === r.index) return;
    if (r.index === -1) r.draft = text;
    r.index = next;
    setText(next === -1 ? r.draft : (history[next] ?? ''));
  };

  return (
    <form
      className="input-bar"
      aria-label="ask mai"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {about && (
        <div className="about-chip" data-testid="about-chip">
          follow-up about {about} · <span className="kbd">esc</span> for a new request
        </div>
      )}
      <textarea
        ref={inputRef}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          recall.current.index = -1;
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          } else if (e.key === 'ArrowUp' && el.selectionStart === 0 && el.selectionEnd === 0) {
            e.preventDefault();
            step(1);
          } else if (
            e.key === 'ArrowDown' &&
            recall.current.index >= 0 &&
            el.selectionStart === text.length
          ) {
            e.preventDefault();
            step(-1);
          }
        }}
        placeholder={placeholder}
        aria-label="request"
        autoComplete="off"
        spellCheck={false}
      />
      <span className="send-hint kbd" aria-hidden="true">
        ↵
      </span>
    </form>
  );
}

export function InboxView({
  approvals,
  needsYou,
  act,
  home,
  now,
  onBack,
  onOpenJob,
  onRetry,
}: {
  approvals: { approval: ApprovalEvent; job: JobState }[];
  needsYou: JobState[];
  act: Act;
  home: string;
  now: number;
  onBack: () => void;
  onOpenJob: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <div className="job-view" data-testid="inbox">
      <div className="meta">
        <button type="button" className="link" onClick={onBack} aria-keyshortcuts="Escape">
          ← back{' '}
          <span className="kbd" aria-hidden="true">
            esc
          </span>
        </button>
      </div>
      <h1>Inbox</h1>
      <InboxItems
        approvals={approvals}
        needsYou={needsYou}
        act={act}
        home={home}
        now={now}
        onOpenJob={onOpenJob}
        onRetry={onRetry}
      />
    </div>
  );
}

// Everything waiting for the user; shown in the home sidebar and in the inbox view.
export function InboxItems({
  approvals,
  needsYou,
  act,
  home,
  now,
  onOpenJob,
  onRetry,
}: {
  approvals: { approval: ApprovalEvent; job: JobState }[];
  needsYou: JobState[];
  act: Act;
  home: string;
  now: number;
  onOpenJob: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <>
      {approvals.length === 0 && needsYou.length === 0 && (
        <p className="muted">Nothing is waiting for you.</p>
      )}
      {approvals.map(({ approval, job }, i) => (
        <ApprovalCard
          key={approval.approvalId}
          approval={approval}
          job={job}
          act={act}
          home={home}
          now={now}
          isTarget={i === 0}
          onOpenJob={() => onOpenJob(job.job.id)}
        />
      ))}
      {needsYou.map((j) => (
        <section key={j.job.id} className="needs-you" aria-label={j.job.title}>
          <div className="approval-head">
            <h3 className="label">{j.status === 'failed' ? 'failed' : 'needs you'}</h3>
            <button type="button" className="link" onClick={() => onOpenJob(j.job.id)}>
              {j.job.title}
            </button>
          </div>
          {j.status === 'failed' && j.error && <p className="error">{j.error}</p>}
          {(j.report?.needs_you.length ?? 0) > 0 && (
            <ul>
              {j.report?.needs_you.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          )}
          <div className="actions">
            {j.status === 'failed' && (
              <button type="button" className="button" onClick={() => onRetry(j.job.id)}>
                Retry
              </button>
            )}
            <button
              type="button"
              className="button"
              onClick={() => act({ type: 'dismiss', jobId: j.job.id })}
            >
              Dismiss
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

export function HistoryView({
  jobs,
  now,
  onBack,
  onOpenJob,
}: {
  jobs: JobState[];
  now: number;
  onBack: () => void;
  onOpenJob: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const found = searchJobs(jobs, query);
  const sel = Math.min(selected, Math.max(0, found.length - 1));
  return (
    <div className="job-view" data-testid="history">
      <div className="meta">
        <button type="button" className="link" onClick={onBack} aria-keyshortcuts="Escape">
          ← back{' '}
          <span className="kbd" aria-hidden="true">
            esc
          </span>
        </button>
        <span>
          {found.length} of {jobs.length} jobs
        </span>
      </div>
      <h1>History</h1>
      <div className="search-wrap">
        <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.75" />
          <path d="m10.5 10.5 3.25 3.25" />
        </svg>
        <input
          className="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const by = e.key === 'ArrowDown' ? 1 : -1;
              setSelected(Math.min(found.length - 1, Math.max(0, sel + by)));
            } else if (e.key === 'Enter' && found[sel]) {
              onOpenJob(found[sel].job.id);
            } else if (e.key === 'Escape' && query) {
              e.stopPropagation();
              setQuery('');
            }
          }}
          placeholder="Search titles, instructions, folders and reports · ↑↓ Enter"
          aria-label="search jobs"
          // biome-ignore lint/a11y/noAutofocus: the view exists to type a search
          autoFocus
        />
      </div>
      <ul className="board list">
        {found.map((j, i) => (
          <li key={j.job.id} data-selected={i === sel} className="history-row">
            <JobRow state={j} now={now} onOpen={() => onOpenJob(j.job.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
