import type { Settings } from '@mai/protocol';
import { useEffect, useId, useState } from 'react';
import type { Act } from './ui';

const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'];

type Key = keyof Settings;

function TextField({
  name,
  label,
  hint,
  value,
  save,
  list,
}: {
  name: Key;
  label: string;
  hint?: string;
  value: string;
  save: (key: Key, value: string) => void;
  list?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        className="search"
        value={draft}
        list={list}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== value && save(name, draft)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        spellCheck={false}
      />
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function NumberField({
  name,
  label,
  hint,
  value,
  unit,
  save,
}: {
  name: Key;
  label: string;
  hint?: string;
  value: number;
  unit?: string;
  save: (key: Key, value: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n !== value) save(name, n);
    else setDraft(String(value));
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="field-number">
        <input
          id={id}
          name={name}
          className="search"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {unit && <span className="muted small">{unit}</span>}
      </span>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function Toggle({
  name,
  label,
  hint,
  value,
  save,
}: {
  name: Key;
  label: string;
  hint?: string;
  value: boolean;
  save: (key: Key, value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="field field-toggle">
      <input
        id={id}
        name={name}
        type="checkbox"
        checked={value}
        onChange={(e) => save(name, e.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function SettingsView({
  settings,
  act,
  onBack,
}: {
  settings: Settings | null;
  act: Act;
  onBack: () => void;
}) {
  const [notSent, setNotSent] = useState(false);
  const save = (key: Key, value: string | number | boolean) => {
    setNotSent(!act({ type: 'set_settings', patch: { [key]: value } }));
  };
  return (
    <div className="job-view settings" data-testid="settings">
      <div className="meta">
        <button type="button" className="link" onClick={onBack} aria-keyshortcuts="Escape">
          ← back{' '}
          <span className="kbd" aria-hidden="true">
            esc
          </span>
        </button>
        <span>Changes save as you go.</span>
        {notSent && <span className="error">Not connected, nothing was saved.</span>}
      </div>
      <h1>Settings</h1>
      {!settings ? (
        <p className="muted">Waiting for mai to connect…</p>
      ) : (
        <>
          <datalist id="models">
            {MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <section className="settings-group" aria-labelledby="set-models">
            <h2 id="set-models" className="label">
              models
            </h2>
            <TextField
              name="deskModel"
              label="Front desk"
              hint="Answers you and hands out jobs. A fast model keeps replies around a second."
              value={settings.deskModel}
              list="models"
              save={save}
            />
            <TextField
              name="workerModel"
              label="Workers"
              hint="Does the actual work in jobs. New jobs use it; running ones keep theirs."
              value={settings.workerModel}
              list="models"
              save={save}
            />
          </section>
          <section className="settings-group" aria-labelledby="set-jobs">
            <h2 id="set-jobs" className="label">
              jobs
            </h2>
            <NumberField
              name="maxParallel"
              label="Jobs at once"
              hint="More run in parallel, the faster your plan limits are used. 1 to 8."
              value={settings.maxParallel}
              save={save}
            />
            <NumberField
              name="jobMaxTurns"
              label="Step limit per job"
              hint="A job stops after this many agent steps."
              value={settings.jobMaxTurns}
              unit="steps"
              save={save}
            />
            <NumberField
              name="jobMaxCostUsd"
              label="Cost cap per job"
              hint="API-equivalent cost at which a job stops. 0 means no cap."
              value={settings.jobMaxCostUsd}
              unit="USD"
              save={save}
            />
            <NumberField
              name="jobIdleMinutes"
              label="Stop hung jobs after"
              hint="A running job with no new step for this long is stopped. Time waiting for your approval does not count."
              value={settings.jobIdleMinutes}
              unit="minutes"
              save={save}
            />
            <TextField
              name="workspace"
              label="Job folder"
              hint="New jobs get a folder inside this one. Must be an absolute path."
              value={settings.workspace}
              save={save}
            />
          </section>
          <section className="settings-group" aria-labelledby="set-limits">
            <h2 id="set-limits" className="label">
              plan limits
            </h2>
            <NumberField
              name="pauseAtUsagePct"
              label="Hold new jobs at"
              hint="When the 5-hour or weekly limit reaches this, new jobs wait instead of starting. 100 means never."
              value={settings.pauseAtUsagePct}
              unit="%"
              save={save}
            />
            <Toggle
              name="apiKeyMode"
              label="Use my ANTHROPIC_API_KEY instead of my Claude subscription"
              hint="Bills the API account of that key. Plan limits are then not shown."
              value={settings.apiKeyMode}
              save={save}
            />
          </section>
          <section className="settings-group" aria-labelledby="set-memory">
            <h2 id="set-memory" className="label">
              memory
            </h2>
            <Toggle
              name="memory"
              label="Give the front desk and jobs my notes"
              hint="me.md, now.md and projects.md are always included; other notes are read when relevant. Jobs may only append to inbox.md and decisions.md; any other change asks you first."
              value={settings.memory}
              save={save}
            />
            <TextField
              name="contextDir"
              label="Notes folder"
              hint="Absolute path to your context folder."
              value={settings.contextDir}
              save={save}
            />
          </section>
          <section className="settings-group" aria-labelledby="set-other">
            <h2 id="set-other" className="label">
              other
            </h2>
            <Toggle
              name="connectors"
              label="Let jobs use my connected accounts (Gmail, Slack, Drive, Atlassian…)"
              hint="The claude.ai connectors you set up. Reading and searching are free; sending, posting, editing, deleting or sharing always asks you first."
              value={settings.connectors}
              save={save}
            />
            <Toggle
              name="notifications"
              label="Desktop notifications when mai is in the background"
              hint="For approvals and finished or failed jobs."
              value={settings.notifications}
              save={save}
            />
            <Toggle
              name="browserHeaded"
              label="Show the workers' browser window"
              hint="Some shops block hidden browsers; showing it can get past their checks."
              value={settings.browserHeaded}
              save={save}
            />
          </section>
        </>
      )}
    </div>
  );
}
