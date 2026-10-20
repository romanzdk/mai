import type { MaiEvent } from '@mai/protocol';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setAttention, useDaemon } from './daemon';
import { derive, isActive, type JobState, jobCounts } from './derive';
import { JobRow, JobView } from './job';
import {
  Conversation,
  EmptyState,
  HistoryView,
  InboxItems,
  InboxView,
  InputBar,
  Notices,
  TopBar,
} from './panels';
import { isMod, SHORTCUT_KEYS, useNow } from './ui';

type View =
  | { name: 'home' }
  | { name: 'inbox' }
  | { name: 'history' }
  | { name: 'job'; id: string };

const HOME: View = { name: 'home' };
const sameView = (a: View, b: View) =>
  a.name === b.name && (a.name !== 'job' || (b.name === 'job' && a.id === b.id));

// One sentence for screen readers per event worth hearing; streaming deltas are skipped.
function announcement(e: MaiEvent, jobs: Map<string, JobState>): string | undefined {
  const title = e.jobId ? (jobs.get(e.jobId)?.job.title ?? 'a job') : '';
  switch (e.kind) {
    case 'desk_reply':
      return e.text;
    case 'desk_error':
      return `Error: ${e.message}`;
    case 'approval_requested':
      return `Approval needed for ${title}: ${e.reason}: ${e.command}`;
    case 'job_status':
      return ['done', 'failed', 'cancelled'].includes(e.status)
        ? `${title} ${e.status}${e.error ? `: ${e.error}` : ''}`
        : undefined;
    default:
      return undefined;
  }
}

export function App() {
  const { connection, home, events, deltas, pending, auth, usage, send, act, restart } =
    useDaemon();
  const { jobs, exchanges, approvals, needsYou } = useMemo(() => derive(events), [events]);
  const byId = useMemo(() => new Map(jobs.map((j) => [j.job.id, j])), [jobs]);
  const now = useNow(1000);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  // Only the user's own scrolling may unpin the view; the browser also scrolls on its own
  // while reflowing (scroll anchoring, clamping), and those events must not count.
  const userScrollAt = useRef(0);
  const userScrolled = () => {
    userScrollAt.current = Date.now();
  };
  const retrying = useRef<string | null>(null);

  const [stack, setStack] = useState<View[]>([HOME]);
  const view = stack.at(-1) ?? HOME;
  const go = useCallback(
    (v: View) => setStack((s) => (sameView(s.at(-1) ?? HOME, v) ? s : [...s, v])),
    [],
  );
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : [HOME])), []);
  const openJob = useCallback((id: string) => go({ name: 'job', id }), [go]);
  const open = view.name === 'job' ? byId.get(view.id) : undefined;
  const inboxCount = approvals.length + needsYou.length;

  // The input is where focus rests: dictation types into whatever is focused, so text
  // spoken after a click or Esc must not land on <body>.
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) {
      inputRef.current?.focus();
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (e.key === 'Escape') {
        back();
        inputRef.current?.focus();
        return;
      }
      if (isMod(e)) {
        const key = e.key.toLowerCase();
        // The webview reloads on Cmd/Ctrl+R; never let that happen.
        if (key === 'r') e.preventDefault();
        const name = SHORTCUT_KEYS[key] ?? (/^[1-9]$/.test(key) ? `row-${key}` : undefined);
        const el = name
          ? document.querySelector<HTMLButtonElement>(`[data-shortcut="${name}"]:not(:disabled)`)
          : null;
        if (el) {
          e.preventDefault();
          el.click();
        }
        return;
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const main = mainRef.current;
        if (main) {
          e.preventDefault();
          userScrollAt.current = Date.now();
          main.scrollBy({ top: (e.key === 'PageUp' ? -0.8 : 0.8) * main.clientHeight });
        }
        return;
      }
      if (!typing && !e.altKey && e.key.length === 1) inputRef.current?.focus();
    };
    // After a mouse click on a button, hand focus back to the input. Keyboard clicks
    // (detail 0) keep focus where it is, so Tab navigation still works.
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.detail > 0 && el?.closest('button')) {
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (!active || active === document.body || active.tagName === 'BUTTON') {
            inputRef.current?.focus();
          }
        });
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [back]);

  // Retry opens the new job as soon as it exists.
  useEffect(() => {
    if (!retrying.current) return;
    const next = jobs.find((j) => j.retryOf === retrying.current);
    if (next) {
      retrying.current = null;
      setStack((s) => [...s.slice(0, -1), { name: 'job', id: next.job.id }]);
    }
  }, [jobs]);
  const retry = (id: string) => {
    if (act({ type: 'retry', jobId: id })) retrying.current = id;
  };

  // Leave an inbox the user just emptied.
  const lastInboxCount = useRef(inboxCount);
  useEffect(() => {
    if (view.name === 'inbox' && inboxCount === 0 && lastInboxCount.current > 0) back();
    lastInboxCount.current = inboxCount;
  }, [inboxCount, view.name, back]);

  // Pinned to the bottom like a terminal: new content keeps the newest line in sight unless
  // the user has scrolled up to read.
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    atBottom.current = view.name === 'home';
    main.scrollTop = atBottom.current ? main.scrollHeight : 0;
  }, [view]);
  // Re-pin when the box resizes and also when the content reflows taller (a narrower
  // window wraps more lines without changing the scroll box itself).
  const pin = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (!pin.current) {
      pin.current = new ResizeObserver(() => {
        if (atBottom.current) main.scrollTop = main.scrollHeight;
      });
      pin.current.observe(main);
    }
    const content = main.firstElementChild;
    if (content) pin.current.observe(content);
    if (atBottom.current) main.scrollTop = main.scrollHeight;
  });
  useEffect(() => () => pin.current?.disconnect(), []);

  const [announce, setAnnounce] = useState('');
  const announced = useRef(0);
  useEffect(() => {
    const fresh = events.filter((e) => e.id > announced.current);
    if (fresh.length === 0) return;
    announced.current = fresh.at(-1)?.id ?? announced.current;
    // Replayed history on connect is not news.
    if (fresh.length > 20) return;
    const text = fresh
      .map((e) => announcement(e, byId))
      .filter(Boolean)
      .at(-1);
    if (text) setAnnounce(text);
  }, [events, byId]);

  useEffect(() => {
    document.title = inboxCount ? `(${inboxCount}) mai` : 'mai';
    setAttention(inboxCount);
  }, [inboxCount]);

  const active = jobs.filter(isActive).reverse();
  const finished = jobs
    .filter((j) => !isActive(j))
    .slice(0, 8)
    .reverse();
  // Number rows from the bottom up, nearest the input first, the way the eye reads them.
  const rowIndex = new Map(
    [...active]
      .reverse()
      .concat([...finished].reverse())
      .map((j, i) => [j.job.id, i]),
  );
  const counts = jobCounts(jobs);
  const homeExchanges = exchanges.filter((e) => !e.aboutJobId).slice(-4);
  const homePending = pending.filter((p) => !p.aboutJobId);
  const history = exchanges.map((e) => e.text).reverse();
  const signedOut = auth.state === 'logged_out' || auth.state === 'login_started';

  return (
    <div className="app">
      <TopBar
        connection={connection}
        inboxCount={inboxCount}
        counts={counts}
        usage={usage}
        now={now}
        onInbox={() => go({ name: 'inbox' })}
        onHistory={() => go({ name: 'history' })}
      />
      <main
        ref={mainRef}
        className="main"
        onWheel={userScrolled}
        onTouchMove={userScrolled}
        onPointerDown={userScrolled}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (near || Date.now() - userScrollAt.current < 600) atBottom.current = near;
        }}
      >
        {view.name === 'inbox' ? (
          <InboxView
            approvals={approvals}
            needsYou={needsYou}
            act={act}
            home={home}
            now={now}
            onBack={back}
            onOpenJob={openJob}
            onRetry={retry}
          />
        ) : view.name === 'history' ? (
          <HistoryView jobs={jobs} now={now} onBack={back} onOpenJob={openJob} />
        ) : open ? (
          <JobView
            state={open}
            act={act}
            now={now}
            home={home}
            onBack={back}
            onOpenJob={openJob}
            onRetry={() => retry(open.job.id)}
            onDismiss={() => {
              if (act({ type: 'dismiss', jobId: open.job.id })) back();
            }}
          >
            <Conversation
              exchanges={exchanges.filter((e) => e.aboutJobId === open.job.id)}
              deltas={deltas}
              pending={pending.filter((p) => p.aboutJobId === open.job.id)}
              jobs={byId}
              now={now}
              onOpenJob={openJob}
            />
          </JobView>
        ) : (
          <div className="home-layout">
            <div className="home">
              <h1 className="sr-only">Home</h1>
              {jobs.length === 0 && <EmptyState />}
              <section className="board" data-testid="board" aria-label="jobs">
                {finished.length > 0 && <h2 className="label">recent</h2>}
                <ul className="list">
                  {finished.map((j) => (
                    <li key={j.job.id}>
                      <JobRow
                        state={j}
                        now={now}
                        index={rowIndex.get(j.job.id)}
                        onOpen={() => openJob(j.job.id)}
                      />
                    </li>
                  ))}
                </ul>
                <ul className="live">
                  {active.map((j) => (
                    <li key={j.job.id}>
                      <JobRow
                        state={j}
                        now={now}
                        index={rowIndex.get(j.job.id)}
                        onOpen={() => openJob(j.job.id)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
              <Conversation
                exchanges={homeExchanges}
                deltas={deltas}
                pending={homePending}
                jobs={byId}
                now={now}
                onOpenJob={openJob}
              />
            </div>
            <aside className="inbox-side" aria-label="inbox" data-testid="inbox-side">
              <h2 className="label side-title">
                inbox{inboxCount > 0 && <span className="count">{inboxCount}</span>}
              </h2>
              {inboxCount === 0 ? (
                <p className="muted small">Nothing is waiting for you.</p>
              ) : (
                <InboxItems
                  approvals={approvals}
                  needsYou={needsYou}
                  act={act}
                  home={home}
                  now={now}
                  onOpenJob={openJob}
                  onRetry={retry}
                />
              )}
            </aside>
          </div>
        )}
      </main>
      <Notices
        connection={connection}
        now={now}
        auth={auth}
        act={act}
        restart={restart}
        approvals={approvals}
        showApprovalStrip={
          view.name !== 'home' && view.name !== 'inbox' && !open?.pendingApprovals.length
        }
        onInbox={() => go({ name: 'inbox' })}
      />
      <InputBar
        inputRef={inputRef}
        onSend={(text) => send(text, open?.job.id)}
        {...(open ? { about: open.job.title } : {})}
        placeholder={
          signedOut
            ? 'Sign in to Claude first'
            : connection.status !== 'connected'
              ? 'Connecting… you can type already'
              : open
                ? 'Ask about this job'
                : 'What do you want done?'
        }
        history={history}
      />
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
