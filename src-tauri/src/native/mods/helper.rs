//! Read-only Rust Mod discovery. One bounded native child runs at a time.
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    NosLayout,
    NosRoles,
    NosPalette,
    Snr,
    Toh,
}
pub struct Response {
    pub kind: Kind,
    pub session: u64,
    pub value: Result<Value, String>,
}
struct Job {
    kind: Kind,
    pid: u32,
    session: u64,
    x64: bool,
}
pub struct Broker {
    sender: mpsc::SyncSender<Job>,
    pub receiver: mpsc::Receiver<Response>,
    stop: Arc<AtomicBool>,
}
impl Broker {
    pub fn new(resources: PathBuf) -> Self {
        let (sender, jobs) = mpsc::sync_channel::<Job>(4);
        let (results, receiver) = mpsc::sync_channel(8);
        let stop = Arc::new(AtomicBool::new(false));
        let cancel = stop.clone();
        std::thread::spawn(move || {
            while !cancel.load(Ordering::Relaxed) {
                let job = match jobs.recv_timeout(Duration::from_millis(50)) {
                    Ok(j) => j,
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(_) => break,
                };
                let value = run(&resources, &job, &cancel);
                if results
                    .try_send(Response {
                        kind: job.kind,
                        session: job.session,
                        value,
                    })
                    .is_err()
                {
                    break;
                }
            }
        });
        Self {
            sender,
            receiver,
            stop,
        }
    }
    pub fn submit(&self, kind: Kind, pid: u32, x64: bool, session: u64) -> bool {
        self.sender
            .try_send(Job {
                kind,
                pid,
                x64,
                session,
            })
            .is_ok()
    }
}
impl Drop for Broker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
fn run(resources: &Path, job: &Job, cancel: &AtomicBool) -> Result<Value, String> {
    let mode = match job.kind {
        Kind::NosLayout => "--nos-layout",
        Kind::NosRoles => "--nos-roles",
        Kind::NosPalette => "--nos-palette",
        Kind::Snr => "--snr",
        Kind::Toh => "--toh",
    };
    let file=rust_reader(resources, job.x64);
    let args=[job.pid.to_string(),mode.to_owned()];
    let mut command = Command::new(&file);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Mod読み取りツールを起動できません: {e}"))?;
    let overflow = Arc::new(AtomicBool::new(false));
    let collect = |stream: Box<dyn Read + Send>, limit: u64| {
        let (sender, receiver) = mpsc::sync_channel(1);
        let exceeded = overflow.clone();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = stream
                .take(limit + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|e| e.to_string())
                .and_then(|bytes| {
                    if bytes.len() as u64 > limit {
                        exceeded.store(true, Ordering::Relaxed);
                        Err("Mod helper output limit reached".into())
                    } else {
                        Ok(bytes)
                    }
                });
            let _ = sender.send(result);
        });
        receiver
    };
    let output = collect(Box::new(child.stdout.take().unwrap()), 1024 * 1024);
    let _errors = collect(Box::new(child.stderr.take().unwrap()), 16384);
    let started = Instant::now();
    let mut checked = Instant::now() - Duration::from_secs(1);
    let status = loop {
        let excessive = if checked.elapsed() >= Duration::from_millis(200) {
            checked = Instant::now();
            private_bytes(&child).is_ok_and(|n| n > 768 * 1024 * 1024)
        } else {
            false
        };
        if cancel.load(Ordering::Relaxed)
            || overflow.load(Ordering::Relaxed)
            || started.elapsed() > Duration::from_secs(45)
            || excessive
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if excessive {
                "Mod読み取りツールのメモリ上限に達しました"
            } else {
                "Mod読み取りツールを停止しました（キャンセル・制限・タイムアウト）"
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    let bytes = output
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Mod helper output did not close")??;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Mod読み取り結果が不正です: {e}"))?;
    if !status.success() || value["status"] != "ok" || value["pid"].as_u64() != Some(job.pid as u64)
    {
        return Err(value["message"]
            .as_str()
            .unwrap_or("Mod読み取りに失敗しました")
            .chars()
            .take(1024)
            .collect());
    }
    Ok(value)
}
pub(super) fn rust_reader(resources: &Path, x64: bool) -> PathBuf {
    resources.join("out/rust-clr").join(if x64 {"x64"} else {"x86"}).join("tbcl-clr-reader.exe")
}
#[cfg(windows)]
pub(super) fn private_bytes(child: &std::process::Child) -> Result<u64, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&counters) as u32;
    counters.cb = size;
    if unsafe {
        GetProcessMemoryInfo(
            child.as_raw_handle(),
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            size,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(counters.PrivateUsage as u64)
}
#[cfg(not(windows))]
fn private_bytes(_: &std::process::Child) -> Result<u64, String> {
    Ok(0)
}
