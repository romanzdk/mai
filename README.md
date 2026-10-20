# mai

A personal AI shell for macOS and Ubuntu. You type or say what you want; a fast front-desk model
answers or hands the work to background Claude workers, and every job ends with a short report.
It runs full-screen on top of your normal OS. It is not a kernel or a distro.

Status: **M0 skeleton** — window, daemon sidecar, WebSocket ping. See [docs/SPEC.md](docs/SPEC.md)
for the plan.

## Install and run

Needs [Rust](https://rustup.rs), [pnpm](https://pnpm.io) and any Node ≥ 24 to run pnpm. On Ubuntu,
also the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux).

```sh
git clone <this repo> mai && cd mai && pnpm install && pnpm dev
```

`pnpm install` downloads a pinned Node 24 binary that the app ships as its daemon sidecar.

`Cmd/Ctrl+Shift+Space` shows or hides the window. The tray icon has Show/Hide and Quit.

## Layout

| Path                | What                                                       |
| ------------------- | ---------------------------------------------------------- |
| `apps/shell`        | Tauri 2 host (Rust) + React UI                             |
| `apps/daemon`       | Node daemon, WebSocket server, later agents and job queue |
| `packages/protocol` | Versioned JSON messages shared by UI and daemon            |

## License

MIT
