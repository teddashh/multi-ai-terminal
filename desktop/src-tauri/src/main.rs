#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    collections::VecDeque,
    env,
    ffi::{OsStr, OsString},
    io::{BufRead, BufReader, Read},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const STDERR_HISTORY: usize = 20;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct ServerProcess {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

impl ServerProcess {
    fn new() -> Self {
        Self { child: Mutex::new(None), stopping: AtomicBool::new(false) }
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(mut child) = lock(&self.child).take() {
            terminate_child(&mut child);
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn node_binary() -> OsString {
    env::var_os("MAT_NODE").filter(|value| !value.is_empty())
        .unwrap_or_else(|| OsString::from("node"))
}

fn sanitize_child_environment(command: &mut Command) {
    #[cfg(target_os = "linux")]
    for name in [
        "LD_LIBRARY_PATH", "APPDIR", "APPIMAGE", "OWD", "GTK_PATH",
        "GIO_MODULE_DIR", "GST_PLUGIN_SYSTEM_PATH",
    ] {
        command.env_remove(name);
    }
}

fn hide_command_window(command: &mut Command) {
    #[cfg(windows)]
    { command.creation_flags(CREATE_NO_WINDOW); }
}

fn validate_node(binary: &OsStr) -> Result<String, String> {
    let mut command = Command::new(binary);
    command.args(["-e", "console.log(process.versions.node)"]);
    sanitize_child_environment(&mut command);
    hide_command_window(&mut command);
    let output = command.output().map_err(|error| format!(
        "Could not run Node.js at '{}': {error}\n\nInstall Node.js 20 or newer and ensure `node` is on PATH, or set MAT_NODE to a specific Node.js binary.",
        binary.to_string_lossy()
    ))?;
    if !output.status.success() {
        return Err(format!(
            "Node.js validation failed for '{}': {}\n\nInstall Node.js 20 or newer and ensure `node` is on PATH, or set MAT_NODE to a specific Node.js binary.",
            binary.to_string_lossy(), String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let major = version.split('.').next().and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| format!("Node.js returned an unrecognized version: {version}"))?;
    if major < 20 {
        return Err(format!(
            "Node.js {version} is too old. Multi-AI Terminal requires Node.js 20 or newer.\n\nUpdate Node.js, or set MAT_NODE to a compatible binary."
        ));
    }
    Ok(version)
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("Could not reserve a local server port: {error}"))?;
    listener.local_addr().map(|address| address.port())
        .map_err(|error| format!("Could not read the local server port: {error}"))
}

fn show_error(window: &tauri::WebviewWindow, message: &str) {
    let encoded = serde_json::to_string(message)
        .unwrap_or_else(|_| "\"Unknown startup error\"".into());
    if let Err(error) = window.eval(&format!("window.__matShowError?.({encoded});")) {
        eprintln!("[desktop] Could not render startup error: {error}\n{message}");
    }
}

fn forward_output<R: Read + Send + 'static>(
    reader: R,
    stream: &'static str,
    recent_stderr: Option<Arc<Mutex<VecDeque<String>>>>,
) {
    thread::spawn(move || for result in BufReader::new(reader).lines() {
        match result {
            Ok(line) => {
                eprintln!("[server {stream}] {line}");
                if let Some(history) = &recent_stderr {
                    let mut history = lock(history);
                    if history.len() == STDERR_HISTORY { history.pop_front(); }
                    history.push_back(line);
                }
            }
            Err(error) => {
                eprintln!("[desktop] Failed reading server {stream}: {error}");
                break;
            }
        }
    });
}

fn recent_errors(history: &Mutex<VecDeque<String>>) -> String {
    lock(history).iter().cloned().collect::<Vec<_>>().join("\n")
}

fn start_server(window: tauri::WebviewWindow, resources: PathBuf, process: Arc<ServerProcess>) {
    let node = node_binary();
    let version = match validate_node(&node) {
        Ok(version) => version,
        Err(message) => { show_error(&window, &message); return; }
    };
    eprintln!("[desktop] Using Node.js {version} at {}", node.to_string_lossy());
    let port = match free_port() {
        Ok(port) => port,
        Err(message) => { show_error(&window, &message); return; }
    };
    let entry = resources.join("server").join("dist").join("index.js");
    if !entry.is_file() {
        show_error(&window, &format!("Bundled server resource is missing: {}", entry.display()));
        return;
    }
    if process.stopping.load(Ordering::SeqCst) { return; }

    let port_arg = port.to_string();
    let mut command = Command::new(&node);
    command.arg(&entry).args(["--port", port_arg.as_str(), "--host", "127.0.0.1"])
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    sanitize_child_environment(&mut command);
    hide_command_window(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            show_error(&window, &format!("Could not start the bundled server: {error}"));
            return;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    {
        let mut slot = lock(&process.child);
        if process.stopping.load(Ordering::SeqCst) {
            drop(slot);
            terminate_child(&mut child);
            return;
        }
        *slot = Some(child);
    }

    let recent_stderr = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = stdout { forward_output(stdout, "stdout", None); }
    if let Some(stderr) = stderr {
        forward_output(stderr, "stderr", Some(Arc::clone(&recent_stderr)));
    }
    eprintln!("[desktop] Started server process {pid} on 127.0.0.1:{port}");

    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if process.stopping.load(Ordering::SeqCst) { return; }
        if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            let url = match tauri::Url::parse(&format!("http://127.0.0.1:{port}/")) {
                Ok(url) => url,
                Err(error) => {
                    show_error(&window, &format!("Could not construct the server URL: {error}"));
                    return;
                }
            };
            if let Err(error) = window.navigate(url) {
                let fallback = format!("window.location.replace('http://127.0.0.1:{port}/');");
                if let Err(fallback_error) = window.eval(&fallback) {
                    show_error(&window, &format!(
                        "Could not open the local server: {error}; fallback failed: {fallback_error}"
                    ));
                }
            }
            return;
        }
        let exited = {
            let mut slot = lock(&process.child);
            slot.as_mut().and_then(|child| match child.try_wait() {
                Ok(Some(status)) => Some(format!("The server exited before it became ready ({status}).")),
                Ok(None) => None,
                Err(error) => Some(format!("Could not monitor the server process: {error}")),
            })
        };
        if let Some(message) = exited {
            show_error(&window, &format!(
                "{message}\n\nRecent server errors:\n{}", recent_errors(&recent_stderr)
            ));
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
    show_error(&window, &format!(
        "The local server did not become ready within 30 seconds.\n\nRecent server errors:\n{}",
        recent_errors(&recent_stderr)
    ));
}

fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let group = -(child.id() as i32);
        unsafe { libc::kill(group, libc::SIGTERM); }
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            let _ = child.try_wait();
            let present = unsafe { libc::kill(group, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH);
            if !present { let _ = child.wait(); return; }
            thread::sleep(Duration::from_millis(100));
        }
        unsafe { libc::kill(group, libc::SIGKILL); }
        let _ = child.wait();
        return;
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let mut command = Command::new("taskkill");
        command.args(["/PID", pid.as_str(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null());
        hide_command_window(&mut command);
        if let Ok(mut taskkill) = command.spawn() {
            let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
            while Instant::now() < deadline {
                match taskkill.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = taskkill.kill();
            let _ = taskkill.wait();
        }
        let _ = child.kill();
        let _ = child.wait();
        return;
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = child.kill(); let _ = child.wait(); }
}

fn main() {
    let process = Arc::new(ServerProcess::new());
    let setup_process = Arc::clone(&process);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(move |app| {
            let window = tauri::WebviewWindowBuilder::new(
                app, "main", tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Multi-AI Terminal").inner_size(1440.0, 900.0)
            .min_inner_size(1024.0, 640.0).build()?;
            let resources = app.path().resource_dir()?;
            let process = Arc::clone(&setup_process);
            thread::spawn(move || start_server(window, resources, process));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Multi-AI Terminal");

    app.run(move |_app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => process.stop(),
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. }, ..
        } => process.stop(),
        _ => {}
    });
}
