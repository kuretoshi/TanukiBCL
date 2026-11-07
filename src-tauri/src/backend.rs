use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

pub struct Backend {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sequence: AtomicU64,
    alive: AtomicBool,
    #[cfg(windows)]
    _job: Job,
}

impl Backend {
    pub fn start(app: &AppHandle) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let root = if cfg!(debug_assertions) {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../out/tauri-backend")
        } else {
            app.path().resource_dir()?.join("backend")
        };
        let data = app.path().app_config_dir()?;
        fs::create_dir_all(data.join("logs"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(data.join("logs/backend.log"))?;
        let mut command = Command::new(root.join("tanuki-node.exe"));
        command
            .arg(root.join("backend.mjs"))
            .args(std::env::args().skip(1))
            .current_dir(&root)
            .env("TANUKI_TAURI_DATA", &data)
            .env(
                "TANUKI_TAURI_VERSION",
                app.package_info().version.to_string(),
            )
            // Avoid a globally configured Node environment injecting modules.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Tauri game reader: {e}"))?;
        #[cfg(windows)]
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        };
        let input = child.stdin.take().ok_or("Missing worker stdin")?;
        let output = child.stdout.take().ok_or("Missing worker stdout")?;
        let backend = Arc::new(Self {
            child: Mutex::new(child),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            #[cfg(windows)]
            _job: job,
        });
        let reader = backend.clone();
        let host = app.clone();
        let (ready_send, ready_receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match frame["type"].as_str() {
                    Some("ready") => {
                        let _ = ready_send.send(());
                    }
                    Some("response") => {
                        if let Some(id) = frame["id"].as_u64() {
                            if let Some(sender) = reader.pending.lock().unwrap().remove(&id) {
                                let result = frame["error"]
                                    .as_str()
                                    .map(|error| Err(error.to_owned()))
                                    .unwrap_or_else(|| Ok(frame["value"].clone()));
                                let _ = sender.send(result);
                            }
                        }
                    }
                    Some("event") => {
                        if let Some(target) = frame["target"].as_str() {
                            let _ = host.emit_to(
                                target,
                                "backend-ipc",
                                json!({ "channel": frame["channel"], "args": frame["args"] }),
                            );
                        }
                    }
                    Some("control") => {
                        let handle = host.clone();
                        let _ = host.run_on_main_thread(move || crate::control(&handle, &frame));
                    }
                    _ => {}
                }
            }
            reader.alive.store(false, Ordering::SeqCst);
            for (_, sender) in reader.pending.lock().unwrap().drain() {
                let _ = sender.send(Err(
                    "Game reader stopped. Restart the Tauri beta.".to_owned()
                ));
            }
            let _ = host.emit_to("main", "backend-ipc", json!({ "channel": "ERROR", "args": ["読み取りプロセスが終了しました。Tauri版を再起動してください。"] }));
        });
        if ready_receive.recv_timeout(Duration::from_secs(20)).is_err() {
            backend.stop();
            return Err(format!(
                "Game reader failed to start. See {}",
                data.join("logs/backend.log").display()
            )
            .into());
        }
        Ok(backend)
    }

    pub async fn request(
        &self,
        target: &str,
        channel: &str,
        args: Vec<Value>,
        mode: &str,
    ) -> Reply {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("Game reader is not running".into());
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let frame =
            json!({ "id": id, "target": target, "channel": channel, "args": args, "mode": mode });
        let result = {
            let mut input = self.input.lock().unwrap();
            writeln!(input, "{frame}").and_then(|_| input.flush())
        };
        if let Err(error) = result {
            self.pending.lock().unwrap().remove(&id);
            return Err(error.to_string());
        }
        match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(reply)) => reply,
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("Game reader request timed out: {channel}"))
            }
        }
    }

    pub fn stop(&self) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(windows)]
struct Job(isize);
#[cfg(windows)]
impl Job {
    fn attach(child: &Child) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle()) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(error);
            }
            Ok(Self(handle as isize))
        }
    }
}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}
