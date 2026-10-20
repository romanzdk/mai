import { DatabaseSync } from 'node:sqlite';
import type {
  ApprovalDecision,
  EventBody,
  Job,
  JobStatus,
  MaiEvent,
  Report,
  Settings,
} from '@mai/protocol';

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  job_id TEXT,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  project TEXT,
  branch TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  rule_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  command TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

interface JobRow {
  id: string;
  title: string;
  spec: string;
  status: JobStatus;
  model: string;
  cwd: string;
  created_at: number;
  finished_at: number | null;
  project: string | null;
  branch: string | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  title: r.title,
  spec: JSON.parse(r.spec),
  status: r.status,
  model: r.model,
  cwd: r.cwd,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  ...(r.project ? { project: r.project } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
});

// Columns added after a release; CREATE TABLE IF NOT EXISTS does not add them to old files.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ['jobs', 'project', 'TEXT'],
  ['jobs', 'branch', 'TEXT'],
];

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    for (const [table, column, type] of ADDED_COLUMNS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  }

  appendEvent(jobId: string | null, body: EventBody): MaiEvent {
    const ts = Date.now();
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (ts, job_id, body) VALUES (?, ?, ?)')
      .run(ts, jobId, JSON.stringify(body));
    return { ...body, id: Number(lastInsertRowid), ts, jobId };
  }

  eventsSince(id: number): MaiEvent[] {
    return this.toEvents(
      this.db.prepare('SELECT id, ts, job_id, body FROM events WHERE id > ? ORDER BY id').all(id),
    );
  }

  jobEvents(jobId: string): MaiEvent[] {
    return this.toEvents(
      this.db
        .prepare('SELECT id, ts, job_id, body FROM events WHERE job_id = ? ORDER BY id')
        .all(jobId),
    );
  }

  private toEvents(rows: unknown[]): MaiEvent[] {
    return (rows as { id: number; ts: number; job_id: string | null; body: string }[]).map((r) => ({
      ...JSON.parse(r.body),
      id: r.id,
      ts: r.ts,
      jobId: r.job_id,
    }));
  }

  insertJob(job: Job): void {
    this.db
      .prepare(
        'INSERT INTO jobs (id, title, spec, status, model, cwd, created_at, finished_at, project, branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        job.id,
        job.title,
        JSON.stringify(job.spec),
        job.status,
        job.model,
        job.cwd,
        job.createdAt,
        job.finishedAt,
        job.project ?? null,
        job.branch ?? null,
      );
  }

  setJobStatus(id: string, status: JobStatus, finishedAt: number | null = null): void {
    this.db
      .prepare('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?')
      .run(status, finishedAt, id);
  }

  jobs(status?: JobStatus, limit = 50): Job[] {
    const rows = status
      ? this.db
          .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at, rowid LIMIT ?')
          .all(status, limit)
      : this.db
          .prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all(limit);
    return (rows as unknown as JobRow[]).map(toJob);
  }

  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? toJob(row as unknown as JobRow) : undefined;
  }

  insertApproval(a: {
    id: string;
    jobId: string;
    ruleId: string;
    tool: string;
    command: string;
    reason: string;
  }): void {
    this.db
      .prepare(
        'INSERT INTO approvals (id, job_id, rule_id, tool, command, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.id, a.jobId, a.ruleId, a.tool, a.command, a.reason, Date.now());
  }

  decideApproval(id: string, status: ApprovalDecision): void {
    this.db
      .prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  pendingApprovals(): { id: string; jobId: string }[] {
    return this.db
      .prepare("SELECT id, job_id AS jobId FROM approvals WHERE status = 'pending'")
      .all() as { id: string; jobId: string }[];
  }

  getSettings(): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  saveSettings(settings: Settings): void {
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('settings', ?)")
      .run(JSON.stringify(settings));
  }

  gitJobs(): Job[] {
    const rows = this.db.prepare('SELECT * FROM jobs WHERE branch IS NOT NULL').all();
    return (rows as unknown as JobRow[]).map(toJob);
  }

  saveReport(jobId: string, report: Report): void {
    this.db
      .prepare('INSERT OR REPLACE INTO reports (job_id, body, created_at) VALUES (?, ?, ?)')
      .run(jobId, JSON.stringify(report), Date.now());
  }

  report(jobId: string): Report | undefined {
    const row = this.db.prepare('SELECT body FROM reports WHERE job_id = ?').get(jobId) as
      | { body: string }
      | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }

  recentReports(limit: number): { jobId: string; title: string; report: Report }[] {
    const rows = this.db
      .prepare(
        'SELECT r.job_id, j.title, r.body FROM reports r JOIN jobs j ON j.id = r.job_id ORDER BY r.created_at DESC LIMIT ?',
      )
      .all(limit) as { job_id: string; title: string; body: string }[];
    return rows.map((r) => ({ jobId: r.job_id, title: r.title, report: JSON.parse(r.body) }));
  }

  close(): void {
    this.db.close();
  }
}
