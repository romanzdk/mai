import { nextRun, parseCron, type Schedule } from '@mai/protocol';
import { useEffect, useId, useState } from 'react';
import { ago, type JobState, resetLabel, statusLabel } from './derive';
import type { Act } from './ui';

function nextLabel(cron: string, now: number): string {
  try {
    const next = nextRun(parseCron(cron), new Date(now));
    return next ? resetLabel(next.toISOString(), now) : 'never';
  } catch {
    return 'invalid';
  }
}

function TimingEditor({ schedule, act }: { schedule: Schedule; act: Act }) {
  const id = useId();
  const [cron, setCron] = useState(schedule.cron);
  const [when, setWhen] = useState(schedule.when);
  useEffect(() => {
    setCron(schedule.cron);
    setWhen(schedule.when);
  }, [schedule.cron, schedule.when]);
  let error = '';
  try {
    parseCron(cron);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const changed = cron.trim() !== schedule.cron || when.trim() !== schedule.when;
  return (
    <form
      className="timing"
      onSubmit={(e) => {
        e.preventDefault();
        if (!error && changed) {
          act({
            type: 'schedule_update',
            id: schedule.id,
            patch: { cron: cron.trim(), when: when.trim() },
          });
        }
      }}
    >
      <label htmlFor={`${id}-cron`} className="muted small">
        cron (minute hour day month weekday)
      </label>
      <input
        id={`${id}-cron`}
        className="search mono"
        value={cron}
        onChange={(e) => setCron(e.target.value)}
        spellCheck={false}
      />
      <label htmlFor={`${id}-when`} className="muted small">
        in words
      </label>
      <input
        id={`${id}-when`}
        className="search"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
      />
      {error ? <p className="error small">{error}</p> : null}
      <div className="actions">
        <button type="submit" className="button" disabled={Boolean(error) || !changed}>
          Save time
        </button>
      </div>
    </form>
  );
}

function ScheduleCard({
  schedule,
  lastRun,
  now,
  act,
  onOpenJob,
}: {
  schedule: Schedule;
  lastRun?: JobState;
  now: number;
  act: Act;
  onOpenJob: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="schedule-card" data-enabled={schedule.enabled} aria-label={schedule.title}>
      <div className="schedule-head">
        <h2>{schedule.title}</h2>
        <span className="count-chip" data-kind={schedule.enabled ? 'running' : 'paused'}>
          {schedule.enabled ? 'on' : 'paused'}
        </span>
      </div>
      <p className="schedule-when">
        {schedule.when} <span className="muted mono small">{schedule.cron}</span>
      </p>
      <dl className="facts">
        <dt>Next run</dt>
        <dd>{schedule.enabled ? nextLabel(schedule.cron, now) : 'paused'}</dd>
        <dt>Last run</dt>
        <dd>
          {schedule.lastRunAt && schedule.lastJobId ? (
            <button
              type="button"
              className="link"
              onClick={() => onOpenJob(schedule.lastJobId as string)}
            >
              {ago(now - schedule.lastRunAt)} ago{lastRun ? ` · ${statusLabel(lastRun)}` : ''}
            </button>
          ) : (
            'not yet'
          )}
        </dd>
        <dt>Does</dt>
        <dd className="clamp">{schedule.prompt}</dd>
      </dl>
      {editing && <TimingEditor schedule={schedule} act={act} />}
      <div className="actions">
        <button
          type="button"
          className="button"
          onClick={() => act({ type: 'schedule_run', id: schedule.id })}
        >
          Run now
        </button>
        <button
          type="button"
          className="button"
          onClick={() =>
            act({ type: 'schedule_update', id: schedule.id, patch: { enabled: !schedule.enabled } })
          }
        >
          {schedule.enabled ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className="button" onClick={() => setEditing((x) => !x)}>
          {editing ? 'Close' : 'Change time'}
        </button>
        {confirm ? (
          <>
            <button
              type="button"
              className="button danger"
              onClick={() => act({ type: 'schedule_delete', id: schedule.id })}
            >
              Yes, delete
            </button>
            <button type="button" className="button" onClick={() => setConfirm(false)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="button" onClick={() => setConfirm(true)}>
            Delete
          </button>
        )}
      </div>
    </section>
  );
}

export function SchedulesView({
  schedules,
  jobs,
  now,
  act,
  onBack,
  onOpenJob,
}: {
  schedules: Schedule[];
  jobs: Map<string, JobState>;
  now: number;
  act: Act;
  onBack: () => void;
  onOpenJob: (id: string) => void;
}) {
  return (
    <div className="job-view" data-testid="schedules">
      <div className="meta">
        <button type="button" className="link" onClick={onBack} aria-keyshortcuts="Escape">
          ← back{' '}
          <span className="kbd" aria-hidden="true">
            esc
          </span>
        </button>
        <span>Times are this computer's local time.</span>
      </div>
      <h1>Schedules</h1>
      {schedules.length === 0 ? (
        <div className="empty">
          <p>Nothing runs on a schedule yet.</p>
          <p className="muted">
            Tell mai what to do regularly, for example: "every weekday at 7:30, give me a morning
            brief from my mail and Slack". Each run is a normal job; its report lands in the inbox.
          </p>
        </div>
      ) : (
        <div className="schedule-list">
          {schedules.map((s) => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              {...(s.lastJobId && jobs.get(s.lastJobId) ? { lastRun: jobs.get(s.lastJobId) } : {})}
              now={now}
              act={act}
              onOpenJob={onOpenJob}
            />
          ))}
        </div>
      )}
    </div>
  );
}
