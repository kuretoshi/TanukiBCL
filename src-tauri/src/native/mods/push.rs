//! Persistent CLR animation watcher, scoped to one selected SNR process.
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
struct Watch {
    stop: Arc<AtomicBool>,
    rx: mpsc::Receiver<Value>,
}
impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
#[derive(Default)]
pub struct Tracker {
    watch: Option<Watch>,
    pid: u32,
    next: Option<Instant>,
    ids: Vec<u64>,
    stamp: u64,
    origins: HashMap<u64, Value>,
}
impl Tracker {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn update(&mut self, resources: &Path, pid: u32, x64: bool, state: &mut Value) {
        if self.pid != pid || state["gameState"] != 1 {
            self.clear();
            self.pid = pid;
        }
        if state["gameState"] != 1 {
            return;
        }
        if self.watch.is_none() && self.next.is_none_or(|t| Instant::now() >= t) {
            self.next = Some(Instant::now() + Duration::from_secs(10));
            self.watch = spawn(resources, pid, x64).ok();
        }
        if let Some(w) = &self.watch {
            loop {
                match w.rx.try_recv() {
                    Ok(v) => {
                        self.ids.clear();
                        self.stamp = 0;
                        if valid(&v, pid, super::addon::now()) {
                            self.ids = v["playerIds"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .filter_map(Value::as_u64)
                                .collect();
                            self.stamp = v["capturedAt"].as_u64().unwrap();
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        self.watch = None;
                        self.ids.clear();
                        break;
                    }
                }
            }
        }
        let fresh = super::addon::now().saturating_sub(self.stamp) <= 500;
        for p in state["players"].as_array_mut().into_iter().flatten() {
            let Some(id) = p["id"].as_u64() else { continue };
            let connected = p["disconnected"] != true;
            if connected && p["isDead"] != true {
                self.origins
                    .insert(id, serde_json::json!({"x":p["x"],"y":p["y"]}));
            }
            let falling = connected && fresh && self.ids.contains(&id);
            p["snrPushedFalling"] = serde_json::json!(falling);
            if falling {
                p["snrPushOrigin"] = self.origins.get(&id).cloned().unwrap_or(Value::Null);
            }
        }
    }
}
fn valid(v: &Value, pid: u32, t: u64) -> bool {
    v["pid"] == pid
        && v["available"] == true
        && v["capturedAt"]
            .as_u64()
            .is_some_and(|s| s.abs_diff(t) <= 500)
        && v["playerIds"].as_array().is_some_and(|ids| {
            ids.len() <= 256 && ids.iter().all(|n| n.as_u64().is_some_and(|n| n < 256))
        })
}
fn spawn(resources: &Path, pid: u32, x64: bool) -> Result<Watch, String> {
    let mut command = Command::new(super::helper::rust_reader(resources, x64));
    command
        .args([
            pid.to_string(),
            "--push-watch".into(),
            std::process::id().to_string(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let output = child.stdout.take().ok_or("No push watcher pipe")?;
    let (tx, rx) = mpsc::sync_channel(8);
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = stop.clone();
    let exceeded = Arc::new(AtomicBool::new(false));
    let limit = exceeded.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(output);
        loop {
            let mut bytes = Vec::new();
            let mut ended = false;
            while bytes.len() <= 65536 {
                let chunk = match r.fill_buf() {
                    Ok(c) => c,
                    Err(_) => return,
                };
                if chunk.is_empty() {
                    return;
                }
                let end = chunk.iter().position(|b| *b == b'\n');
                let count = end.map_or(chunk.len(), |i| i + 1).min(65537 - bytes.len());
                bytes.extend_from_slice(&chunk[..count]);
                r.consume(count);
                if end.is_some() {
                    ended = true;
                    break;
                }
            }
            if !ended || bytes.len() > 65536 {
                limit.store(true, Ordering::Relaxed);
                return;
            }
            let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            match tx.try_send(value) {
                Ok(_) => {}
                Err(mpsc::TrySendError::Full(_)) => {}
                Err(_) => return,
            }
        }
    });
    std::thread::spawn(move || {
        while !cancel.load(Ordering::Relaxed)
            && !exceeded.load(Ordering::Relaxed)
            && super::helper::private_bytes(&child).is_ok_and(|n| n <= 768 * 1024 * 1024)
        {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
    Ok(Watch { stop, rx })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn animation_samples_do_not_keep_dead_permission_after_heartbeat() {
        let v =
            serde_json::json!({"pid":42,"available":true,"capturedAt":1000,"playerIds":[1,255]});
        assert!(valid(&v, 42, 1500));
        assert!(!valid(&v, 42, 1501));
        assert!(!valid(&v, 43, 1000));
    }
}
