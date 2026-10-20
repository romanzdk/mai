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

## Install

Needs [Rust](https://rustup.rs), [pnpm](https://pnpm.io), any Node ≥ 24 to run pnpm, and a
signed-in [Claude Code](https://code.claude.com) (`claude login`, your subscription). On
Ubuntu, also the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux).

```sh
git clone <this repo> mai && cd mai && pnpm install && pnpm app:install
```

This builds the app, installs it for your user (`~/Applications/mai.app` on macOS,
`~/.local/bin/mai.AppImage` plus a menu entry on Linux) and starts it. The first start
registers mai to start at login (switch it off in Settings) and downloads the browser that
web tasks use. Run the same command again to update.

For development: `pnpm install && pnpm dev`.

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
