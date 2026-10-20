import type { AuthState } from '@mai/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Action, type Connection, useDaemon } from './daemon';
import {
  ACTIVE,
  type ApprovalEvent,
  derive,
  type Exchange,
  type JobState,
  timelineLine,
} from './derive';

type Act = (msg: Action) => void;
type View = { name: 'home' } | { name: 'inbox' } | { name: 'job'; id: string };

const useNow = (ms: number) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

const statusLabel = (s: string) => s.replace('_', ' ');

function StatusLine({
  connection,
  inboxCount,
  onInbox,
}: {
  connection: Connection;
  inboxCount: number;
  onInbox: () => void;
}) {
  const now = useNow(1000);
  return (
    <div className="status" data-testid="daemon-status">
      <span>
        <span className="dot" data-state={connection.status}>
          ●
        </span>{' '}
        daemon {connection.status}
      </span>
      {connection.status === 'connected' && (
        <>
          <span>v{connection.version}</span>
          <span>up {Math.round((now - connection.startedAt) / 1000)}s</span>
          {connection.rtt !== undefined && <span>rtt {connection.rtt} ms</span>}
        </>
      )}
      <button
        type="button"
        className="link inbox-link"
        data-attention={inboxCount > 0}
        onClick={onInbox}
      >
        inbox {inboxCount}
      </button>
    </div>
  );
}

function LoginBanner({ auth, act }: { auth: { state: AuthState; detail?: string }; act: Act }) {
  if (auth.state !== 'logged_out' && auth.state !== 'login_started') return null;
  return (
    <div className="banner" data-testid="login">
      {auth.state === 'logged_out' ? (
        <>
          <span>Not signed in to Claude{auth.detail ? ` (${auth.detail})` : ''}.</span>
          <button type="button" className="button primary" onClick={() => act({ type: 'login' })}>
            Sign in
          </button>
        </>
      ) : (
        <span>Finish signing in in the Terminal window. This updates by itself.</span>
      )}
    </div>
  );
}

function JobRow({ state, onOpen }: { state: JobState; onOpen: () => void }) {
  const last = state.timeline.at(-1);
  const line = state.report?.summary ?? (last ? timelineLine(last) : state.status);
  return (
    <button type="button" className="job" data-status={state.status} onClick={onOpen}>
      <span className="job-status">{statusLabel(state.status)}</span>
      <span className="job-title">{state.job.title}</span>
      <span className="job-line">{line}</span>
    </button>
  );
}

function ApprovalCard({
  approval,
  job,
  act,
  onOpenJob,
}: {
  approval: ApprovalEvent;
  job: JobState;
  act: Act;
  onOpenJob?: () => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <div className="approval" data-testid="approval">
      <div className="approval-head">
        <span className="label">needs approval · {approval.reason}</span>
        {onOpenJob ? (
          <button type="button" className="link" onClick={onOpenJob}>
            {job.job.title}
          </button>
        ) : null}
      </div>
      <pre className="command">{approval.command}</pre>
      <div className="actions">
        <button
          type="button"
          className="button primary"
          onClick={() => act({ type: 'approve', approvalId: approval.approvalId, remember })}
        >
          Approve
        </button>
        <button
          type="button"
          className="button danger"
          onClick={() => act({ type: 'deny', approvalId: approval.approvalId })}
        >
          Deny
        </button>
        <label className="muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />{' '}
          allow this kind of action in this job folder until mai restarts
        </label>
      </div>
    </div>
  );
}

function ReportCard({ state }: { state: JobState }) {
  const r = state.report;
  if (!r) return null;
  const list = (label: string, items: string[]) =>
    items.length > 0 && (
      <div className="report-list">
        <span className="label">{label}</span>
        <ul>
          {items.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="report" data-testid="report">
      <p>{r.summary}</p>
      {list('needs you', r.needs_you)}
      {list('changes', r.changes)}
      {list('artifacts', r.artifacts)}
    </div>
  );
}

function JobView({
  state,
  act,
  onBack,
  onOpenJob,
}: {
  state: JobState;
  act: Act;
  onBack: () => void;
  onOpenJob: (id: string) => void;
}) {
  const id = state.job.id;
  const active = ACTIVE.includes(state.status);
  return (
    <div className="job-view">
      <div className="job-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← back (esc)
        </button>
        <h2>{state.job.title}</h2>
        <span className="job-status" data-status={state.status}>
          {statusLabel(state.status)}
        </span>
        <span className="muted mono">{state.job.cwd}</span>
        {state.retryOf && (
          <button type="button" className="link" onClick={() => onOpenJob(state.retryOf as string)}>
            retry of {state.retryOf}
          </button>
        )}
      </div>
      <div className="actions">
        {active ? (
          <button
            type="button"
            className="button danger"
            onClick={() => act({ type: 'cancel', jobId: id })}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="button"
            onClick={() => act({ type: 'retry', jobId: id })}
          >
            Retry
          </button>
        )}
        <button
          type="button"
          className="button"
          onClick={() => act({ type: 'open_folder', jobId: id })}
        >
          Open folder
        </button>
      </div>
      {state.pendingApprovals.map((a) => (
        <ApprovalCard key={a.approvalId} approval={a} job={state} act={act} />
      ))}
      <ReportCard state={state} />
      {state.error && <p className="error">{state.error}</p>}
      <ol className="timeline">
        {state.timeline
          .filter((e) => e.kind !== 'job_report')
          .map((e) => (
            <li key={e.id} data-kind={e.kind}>
              <span className="muted">{new Date(e.ts).toLocaleTimeString()}</span>
              <span>{e.kind === 'job_text' ? e.text : timelineLine(e)}</span>
            </li>
          ))}
      </ol>
    </div>
  );
}

function InboxView({
  approvals,
  needsYou,
  act,
  onBack,
  onOpenJob,
}: {
  approvals: { approval: ApprovalEvent; job: JobState }[];
  needsYou: JobState[];
  act: Act;
  onBack: () => void;
  onOpenJob: (id: string) => void;
}) {
  return (
    <div className="job-view" data-testid="inbox">
      <div className="job-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← back (esc)
        </button>
        <h2>Inbox</h2>
      </div>
      {approvals.length === 0 && needsYou.length === 0 && (
        <p className="muted">Nothing is waiting for you.</p>
      )}
      {approvals.map(({ approval, job }) => (
        <ApprovalCard
          key={approval.approvalId}
          approval={approval}
          job={job}
          act={act}
          onOpenJob={() => onOpenJob(job.job.id)}
        />
      ))}
      {needsYou.map((j) => (
        <div key={j.job.id} className="needs-you">
          <div className="approval-head">
            <span className="label">needs you · {statusLabel(j.status)}</span>
            <button type="button" className="link" onClick={() => onOpenJob(j.job.id)}>
              {j.job.title}
            </button>
          </div>
          <ul>
            {j.report?.needs_you.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <button
            type="button"
            className="button"
            onClick={() => act({ type: 'dismiss', jobId: j.job.id })}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}

function Conversation({
  exchanges,
  deltas,
  pending,
}: {
  exchanges: Exchange[];
  deltas: Record<string, string>;
  pending: { inputId: string; text: string }[];
}) {
  const items = [
    ...exchanges.slice(-6),
    ...pending.map((p): Exchange => ({ ...p, ts: 0, jobIds: [] })),
  ];
  return (
    <div className="conversation" data-testid="conversation">
      {items.map((ex) => (
        <div key={ex.inputId} className="exchange">
          <div className="you">{ex.text}</div>
          <div className="desk">
            {ex.error ? (
              <span className="error">{ex.error}</span>
            ) : (
              (ex.reply ?? deltas[ex.inputId] ?? <span className="muted">…</span>)
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function InputBar({ onSend, disabled }: { onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="input-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim() || disabled) return;
        onSend(text.trim());
        setText('');
      }}
    >
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={disabled ? 'waiting for the daemon…' : 'What do you want done?'}
        aria-label="request"
        autoComplete="off"
        spellCheck={false}
      />
    </form>
  );
}

export function App() {
  const { connection, events, deltas, pending, auth, send, act } = useDaemon();
  const { jobs, exchanges, approvals, needsYou } = useMemo(() => derive(events), [events]);
  const [view, setView] = useState<View>({ name: 'home' });
  const home = () => setView({ name: 'home' });
  const openJob = (id: string) => setView({ name: 'job', id });
  const open = view.name === 'job' ? jobs.find((j) => j.job.id === view.id) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setView({ name: 'home' });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = jobs.filter((j) => ACTIVE.includes(j.status));
  const finished = jobs.filter((j) => !ACTIVE.includes(j.status)).slice(0, 8);

  return (
    <div className="app">
      <StatusLine
        connection={connection}
        inboxCount={approvals.length + needsYou.length}
        onInbox={() => setView({ name: 'inbox' })}
      />
      <main className="main">
        {view.name === 'inbox' ? (
          <InboxView
            approvals={approvals}
            needsYou={needsYou}
            act={act}
            onBack={home}
            onOpenJob={openJob}
          />
        ) : open ? (
          <JobView state={open} act={act} onBack={home} onOpenJob={openJob} />
        ) : (
          <>
            {approvals.map(({ approval, job }) => (
              <ApprovalCard
                key={approval.approvalId}
                approval={approval}
                job={job}
                act={act}
                onOpenJob={() => openJob(job.job.id)}
              />
            ))}
            <section className="board" data-testid="board">
              {active.length === 0 && finished.length === 0 && (
                <p className="muted">No jobs yet.</p>
              )}
              {active.map((j) => (
                <JobRow key={j.job.id} state={j} onOpen={() => openJob(j.job.id)} />
              ))}
              {finished.length > 0 && <h3 className="label">recent</h3>}
              {finished.map((j) => (
                <JobRow key={j.job.id} state={j} onOpen={() => openJob(j.job.id)} />
              ))}
            </section>
            <Conversation exchanges={exchanges} deltas={deltas} pending={pending} />
          </>
        )}
      </main>
      <LoginBanner auth={auth} act={act} />
      <InputBar onSend={send} disabled={connection.status !== 'connected'} />
    </div>
  );
}
