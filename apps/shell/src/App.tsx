import { useEffect, useMemo, useRef, useState } from 'react';
import { type Connection, useDaemon } from './daemon';
import { ACTIVE, derive, type Exchange, type JobState, timelineLine } from './derive';

const useNow = (ms: number) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
};

function StatusLine({ connection }: { connection: Connection }) {
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
    </div>
  );
}

function JobRow({ state, onOpen }: { state: JobState; onOpen: () => void }) {
  const last = state.timeline.at(-1);
  const line = state.report?.summary ?? (last ? timelineLine(last) : state.status);
  return (
    <button type="button" className="job" data-status={state.status} onClick={onOpen}>
      <span className="job-status">{state.status.replace('_', ' ')}</span>
      <span className="job-title">{state.job.title}</span>
      <span className="job-line">{line}</span>
    </button>
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

function JobView({ state, onBack }: { state: JobState; onBack: () => void }) {
  return (
    <div className="job-view">
      <div className="job-view-head">
        <button type="button" className="link" onClick={onBack}>
          ← back (esc)
        </button>
        <h2>{state.job.title}</h2>
        <span className="job-status" data-status={state.status}>
          {state.status.replace('_', ' ')}
        </span>
        <span className="muted mono">{state.job.cwd}</span>
      </div>
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
  const { connection, events, deltas, pending, send } = useDaemon();
  const { jobs, exchanges } = useMemo(() => derive(events), [events]);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const open = jobs.find((j) => j.job.id === openJob);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenJob(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const active = jobs.filter((j) => ACTIVE.includes(j.status));
  const finished = jobs.filter((j) => !ACTIVE.includes(j.status)).slice(0, 8);

  return (
    <div className="app">
      <StatusLine connection={connection} />
      <main className="main">
        {open ? (
          <JobView state={open} onBack={() => setOpenJob(null)} />
        ) : (
          <>
            <section className="board" data-testid="board">
              {active.length === 0 && finished.length === 0 && (
                <p className="muted">No jobs yet.</p>
              )}
              {active.map((j) => (
                <JobRow key={j.job.id} state={j} onOpen={() => setOpenJob(j.job.id)} />
              ))}
              {finished.length > 0 && <h3 className="label">recent</h3>}
              {finished.map((j) => (
                <JobRow key={j.job.id} state={j} onOpen={() => setOpenJob(j.job.id)} />
              ))}
            </section>
            <Conversation exchanges={exchanges} deltas={deltas} pending={pending} />
          </>
        )}
      </main>
      <InputBar onSend={send} disabled={connection.status !== 'connected'} />
    </div>
  );
}
