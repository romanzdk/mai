# mai

A personal AI shell for macOS and Ubuntu. You type or say what you want; a fast front-desk model
answers or hands the work to background Claude workers, and every job ends with a short report.
It runs full-screen on top of your normal OS. It is not a kernel or a distro.

Status: **M4 vertical slice done** — type a request; the front desk answers or dispatches
background workers (two at a time) with shell, file and browser access. Jobs in a git repo work
on their own branch and never push. Deletes outside a job's folder, sudo, git push and web
actions that buy or send something pause behind an approval card. Jobs can be cancelled,
retried, asked about, and searched. See [docs/SPEC.md](docs/SPEC.md)
for the plan.

## Install and run

Needs [Rust](https://rustup.rs), [pnpm](https://pnpm.io) and any Node ≥ 24 to run pnpm. On Ubuntu,
also the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux).

```sh
git clone <this repo> mai && cd mai && pnpm install && pnpm dev
```

`pnpm install` downloads a pinned Node 24 binary (the daemon sidecar) and the Chromium build the
workers' browser uses.

`Cmd/Ctrl+Shift+Space` shows or hides the window. The tray icon has Show/Hide and Quit.

mai uses your Claude subscription through Claude Code's own login (`claude login`); it never
sees your tokens. Jobs work in `~/mai/jobs/<id>` unless you name a project folder.

## Layout

| Path                | What                                                       |
| ------------------- | ---------------------------------------------------------- |
| `apps/shell`        | Tauri 2 host (Rust) + React UI                             |
| `apps/daemon`       | Node daemon: WebSocket server, job queue, SQLite event log |
| `packages/agent`    | Front desk, workers and reports on the Claude Agent SDK   |
| `packages/protocol` | Versioned JSON messages shared by UI and daemon            |

## License

MIT
