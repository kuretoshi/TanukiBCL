//! Optional shared native SenseVoice worker; no Python/CLR runtime is started.
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    time::{Duration, Instant},
};
fn root() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default())
        .join("TanukiBCL/Speech/sherpa-2.0.2")
}
pub fn active_state(state: &Value) -> bool {
    state["mod"] == "NoS"
        && matches!(state["gameState"].as_i64(), Some(1 | 2))
        && state["nosAddonIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id == "tanuki.bcl.roles"))
}
struct Worker {
    child: Child,
    input: ChildStdin,
    lines: mpsc::Receiver<String>,
    used: Instant,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Worker {
    fn new() -> Result<Self, String> {
        #[cfg(windows)]
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(root().join("runtime/TanukiSpeechWorker.exe"));
        command
            .arg(root())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "認識プロセスを起動できません")?;
        let stdout = child.stdout.take().unwrap();
        let input = child.stdin.take().unwrap();
        let (sender, lines) = mpsc::sync_channel(4);
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            loop {
                let mut bytes = Vec::new();
                let count = Read::by_ref(&mut reader)
                    .take(32769)
                    .read_until(b'\n', &mut bytes)
                    .unwrap_or(0);
                if count == 0 || count > 32768 {
                    break;
                }
                let Ok(line) = String::from_utf8(bytes) else {
                    break;
                };
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            lines,
            used: Instant::now(),
        })
    }
    fn transcribe(
        &mut self,
        wav: &[u8],
        maximum: usize,
        deadline: Instant,
        active: &AtomicBool,
        text: bool,
    ) -> Result<Option<String>, String> {
        use base64::Engine;
        self.used = Instant::now();
        static REQUEST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = REQUEST
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            .to_string();
        let request = json!({"id":id,"maximum":maximum,"wav":base64::engine::general_purpose::STANDARD.encode(wav)});
        writeln!(self.input, "{request}").map_err(|_| "認識プロセスに送信できません")?;
        self.input
            .flush()
            .map_err(|_| "認識プロセスに送信できません")?;
        let line = loop {
            if !active.load(Ordering::Acquire) {
                return Err("認識を終了しました".into());
            }
            if Instant::now() >= deadline {
                return Err("認識が時間内に完了しませんでした".into());
            }
            match self.lines.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => break line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => return Err("認識プロセスが終了しました".into()),
            }
        };
        let result: Value = serde_json::from_str(&line).map_err(|_| "認識結果を読めません")?;
        if result["id"] != id || !result["error"].is_null() {
            return Err("高精度ローカル認識に失敗しました".into());
        }
        if text {
            return Ok(result["text"].as_str().filter(|t| t.encode_utf16().count() <= 4096).map(str::to_owned));
        }
        Ok(result["word"]
            .as_str()
            .filter(|w| crate::voice::speech::valid_stone_word(w, maximum))
            .map(str::to_owned))
    }
}
#[derive(Default)]
pub struct LocalSpeech {
    active: AtomicBool,
    queued: std::sync::atomic::AtomicUsize,
    worker: Mutex<Option<Worker>>,
    error: Mutex<String>,
}
impl LocalSpeech {
    pub fn refresh_status(&self) -> Value {
        super::vc_runtime::installed(&root().join("runtime"), true);
        self.status()
    }
    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::Release);
        if !active {
            self.idle();
        }
    }
    pub fn status(&self) -> Value {
        let root = root();
        let runtime_installed = super::vc_runtime::installed(&root.join("runtime"), false);
        let model_available = [
            "runtime/TanukiSpeechWorker.exe",
            "runtime/sherpa-onnx-c-api.dll",
            "runtime/onnxruntime.dll",
            "sensevoice/model.int8.onnx",
            "sensevoice/tokens.txt",
            "silero_vad.onnx",
        ]
        .iter()
        .all(|p| root.join(p).is_file());
        let preferences: Value = std::fs::read(root.join("preferences.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(Value::Null);
        let available = model_available && runtime_installed;
        json!({"runtimeInstalled":runtime_installed,"modelAvailable":model_available,"available":available,"enabled":available&&preferences["enabled"]!=false,"error":self.error.lock().unwrap().clone()})
    }
    pub fn enabled(&self) -> bool {
        self.status()["enabled"] == true
    }
    pub fn save(&self, enabled: &Value) -> bool {
        if !enabled.is_boolean() || self.status()["available"] != true {
            return false;
        }
        std::fs::write(
            root().join("preferences.json"),
            json!({"enabled":enabled}).to_string(),
        )
        .is_ok()
    }
    pub fn transcribe(&self, wav: &[u8], maximum: usize) -> Result<Option<String>, String> {
        self.transcribe_mode(wav, maximum, false)
    }
    pub fn transcribe_text(&self, wav: &[u8]) -> Result<Option<String>, String> {
        self.transcribe_mode(wav, 12, true)
    }
    fn transcribe_mode(&self, wav: &[u8], maximum: usize, text: bool) -> Result<Option<String>, String> {
        if !self.active.load(Ordering::Acquire)
            || !self.enabled()
            || !super::speech_audio::valid_wav(wav)
        {
            return Ok(None);
        }
        use std::sync::atomic::Ordering;
        if self
            .queued
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                (n < 4).then_some(n + 1)
            })
            .is_err()
        {
            return Err("ローカル認識が混雑しています".into());
        }
        struct Slot<'a>(&'a std::sync::atomic::AtomicUsize);
        impl Drop for Slot<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::Relaxed);
            }
        }
        let _slot = Slot(&self.queued);
        let deadline = Instant::now() + Duration::from_secs(18);
        let mut worker = loop {
            if !self.active.load(Ordering::Acquire) {
                return Ok(None);
            }
            if let Ok(worker) = self.worker.try_lock() {
                break worker;
            }
            if Instant::now() >= deadline {
                return Err("認識待ちが時間内に完了しませんでした".into());
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        if !self.active.load(Ordering::Acquire) || !self.enabled() {
            return Ok(None);
        }
        if worker.is_none() {
            *worker = Some(Worker::new()?);
        }
        let result = worker
            .as_mut()
            .unwrap()
            .transcribe(wav, maximum, deadline, &self.active, text);
        if result.is_err() {
            *worker = None;
        }
        if !self.active.load(Ordering::Acquire) {
            *worker = None;
            return Ok(None);
        }
        *self.error.lock().unwrap() = result.as_ref().err().cloned().unwrap_or_default();
        result
    }
    pub fn idle(&self) {
        if let Ok(mut worker) = self.worker.try_lock() {
            if !self.active.load(Ordering::Acquire)
                || worker
                    .as_ref()
                    .is_some_and(|w| w.used.elapsed() > Duration::from_secs(30))
            {
                *worker = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn absent_addon_never_starts_shared_model() {
        let service = LocalSpeech::default();
        let wav = super::super::speech_audio::wav(&vec![1000; 1600]).unwrap();
        for state in [
            Value::Null,
            json!({"mod":"NoS","gameState":1,"nosAddonIds":[]}),
            json!({"mod":"NoS","gameState":1,"nosAddonIds":["UchuAddon"]}),
        ] {
            service.set_active(active_state(&state));
            assert!(service.transcribe(&wav, 8).unwrap().is_none());
            assert!(service.transcribe_text(&wav).unwrap().is_none());
            assert!(service.worker.lock().unwrap().is_none());
        }
        assert!(active_state(
            &json!({"mod":"NoS","gameState":1,"nosAddonIds":["tanuki.bcl.roles"]})
        ));
    }
    #[test]
    #[ignore = "Uses the already prepared shared model and synthetic Japanese corpus"]
    fn recognises_japanese_role_without_api_or_clr() {
        let service = LocalSpeech::default();
        service.set_active(true);
        assert!(service.status()["available"] == true);
        let preference = root().join("preferences.json");
        let old = std::fs::read(&preference).ok();
        struct Restore(PathBuf, Option<Vec<u8>>);
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(bytes) = &self.1 {
                    let _ = std::fs::write(&self.0, bytes);
                } else {
                    let _ = std::fs::remove_file(&self.0);
                }
            }
        }
        let _restore = Restore(preference, old);
        assert!(service.save(&json!(true)));
        let raw = std::fs::read(
            root()
                .parent()
                .unwrap()
                .join("evaluation/Microsoft_Haruka_Desktop-0.wav"),
        )
        .unwrap();
        let mut at = 12;
        let mut pcm = Vec::new();
        while at + 8 <= raw.len() {
            let n = u32::from_le_bytes(raw[at + 4..at + 8].try_into().unwrap()) as usize;
            if &raw[at..at + 4] == b"data" {
                pcm = raw[at + 8..at + 8 + n]
                    .chunks_exact(2)
                    .map(|p| i16::from_le_bytes([p[0], p[1]]))
                    .collect();
                break;
            }
            at += 8 + n + n % 2;
        }
        let wav = super::super::speech_audio::wav(&pcm).unwrap();
        assert_eq!(
            service.transcribe(&wav, 8).unwrap().as_deref(),
            Some("インポスター")
        );
        let process_id=service.worker.lock().unwrap().as_ref().unwrap().child.id();
        for (file,job) in [
            ("Microsoft_Haruka_Desktop-6.wav", json!({"kind":"hero","words":["変身"]})),
            ("Microsoft_Haruka_Desktop-3.wav", json!({"kind":"ng","words":["タスク"]})),
            ("Microsoft_Haruka_Desktop-5.wav", json!({"kind":"ng","words":["インポスター"]})),
        ] {
            let raw=std::fs::read(root().parent().unwrap().join("evaluation").join(file)).unwrap();
            let mut at=12;
            let pcm=loop {
                assert!(at+8<=raw.len());
                let n=u32::from_le_bytes(raw[at+4..at+8].try_into().unwrap())as usize;
                if &raw[at..at+4]==b"data" {break raw[at+8..at+8+n].chunks_exact(2).map(|p|i16::from_le_bytes([p[0],p[1]])).collect::<Vec<_>>();}
                at+=8+n+n%2;
            };
            let text=service.transcribe_text(&super::super::speech_audio::wav(&pcm).unwrap()).unwrap().unwrap();
            assert!(crate::voice::speech::matches(&text,&job,true),"shared hero/NG full transcript failed");
            assert_eq!(service.worker.lock().unwrap().as_ref().unwrap().child.id(),process_id,"one native model serves all roles");
        }
        service.set_active(false);
        assert!(service.worker.lock().unwrap().is_none());
        assert!(service.transcribe(&wav, 8).unwrap().is_none());
        service.set_active(true);
        assert!(service.transcribe(&vec![0; 3244], 8).unwrap().is_none());
        service
            .queued
            .store(4, std::sync::atomic::Ordering::Relaxed);
        assert!(service.transcribe(&wav, 8).is_err());
        service
            .queued
            .store(0, std::sync::atomic::Ordering::Relaxed);
    }
}
