use std::io::Read;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tauri_plugin_global_shortcut::ShortcutState;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

// Must match the line printed by apps/daemon/src/main.ts.
const READY_PREFIX: &str = "MAI_DAEMON_READY ";
const TOGGLE_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Clone, Serialize)]
struct DaemonInfo {
    url: String,
    token: String,
}

#[derive(Default)]
struct Daemon {
    info: Mutex<Option<DaemonInfo>>,
    child: Mutex<Option<CommandChild>>,
}

#[derive(Deserialize)]
struct Ready {
    port: u16,
}

fn parse_ready_line(line: &str) -> Option<u16> {
    let json = line.trim().strip_prefix(READY_PREFIX)?;
    serde_json::from_str::<Ready>(json).ok().map(|r| r.port)
}

fn random_token() -> std::io::Result<String> {
    let mut bytes = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
fn daemon_info(daemon: State<Daemon>) -> Option<DaemonInfo> {
    daemon.info.lock().unwrap().clone()
}

fn spawn_daemon(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let script = app.path().resource_dir()?.join("daemon.mjs");
    let token = random_token()?;
    let (mut rx, child) = app
        .shell()
        .sidecar("node")?
        .arg(script)
        .env("MAI_TOKEN", &token)
        .env("MAI_EXIT_ON_STDIN_EOF", "1")
        .spawn()?;
    *app.state::<Daemon>().child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    match parse_ready_line(&line) {
                        Some(port) => {
                            let info = DaemonInfo {
                                url: format!("ws://127.0.0.1:{port}"),
                                token: token.clone(),
                            };
                            *app.state::<Daemon>().info.lock().unwrap() = Some(info.clone());
                            let _ = app.emit("daemon-ready", info);
                        }
                        None => println!("[daemon] {}", line.trim_end()),
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[daemon] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Terminated(status) => {
                    eprintln!("[daemon] exited with {:?}", status.code);
                    *app.state::<Daemon>().info.lock().unwrap() = None;
                    let _ = app.emit("daemon-exit", status.code);
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([TOGGLE_SHORTCUT])
                .expect("valid shortcut")
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .manage(Daemon::default())
        .invoke_handler(tauri::generate_handler![daemon_info])
        .setup(|app| {
            spawn_daemon(app.handle())?;
            let toggle = MenuItem::with_id(app, "toggle", "Show / hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit mai", true, None::<&str>)?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("bundle icon"))
                .menu(&Menu::with_items(app, &[&toggle, &quit])?)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build mai")
        .run(|app, event| {
            if let RunEvent::Exit = event
                && let Some(child) = app.state::<Daemon>().child.lock().unwrap().take()
            {
                let _ = child.kill();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        assert_eq!(
            parse_ready_line("MAI_DAEMON_READY {\"port\":4242}\n"),
            Some(4242)
        );
    }

    #[test]
    fn ignores_other_lines() {
        assert_eq!(parse_ready_line("hello"), None);
        assert_eq!(parse_ready_line("MAI_DAEMON_READY not-json"), None);
        assert_eq!(parse_ready_line("MAI_DAEMON_READY {\"port\":70000}"), None);
    }

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (random_token().unwrap(), random_token().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
