//! Vosk runs on its own bounded worker. No decoder/model work takes place in
//! WASAPI, the mixer, or the signaling event loop.
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::{c_char, c_void, CStr, CString},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use unicode_normalization::UnicodeNormalization;
pub fn valid_stone_word(word: &str, maximum: usize) -> bool {
    static WORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    (1..=12).contains(&maximum)
        && word.encode_utf16().count() <= 64
        && (1..=maximum).contains(&word.chars().count())
        && word.nfkc().eq(word.chars())
        && WORD
            .get_or_init(|| regex::Regex::new(r"^[\p{L}\p{Nd}ー々]+$").unwrap())
            .is_match(word)
}
fn recognised_stone_word(tokens: &Value, final_result: bool, maximum: usize) -> Option<String> {
    if !final_result {
        return None;
    }
    let tokens = tokens.as_array().filter(|ts| ts.len() <= 64)?;
    const FUNCTION: &[&str] = &[
        "えー",
        "ええ",
        "えっと",
        "あの",
        "その",
        "この",
        "それ",
        "これ",
        "はい",
        "うん",
        "は",
        "が",
        "の",
        "を",
        "に",
        "へ",
        "と",
        "で",
        "も",
        "ね",
        "よ",
        "です",
        "ます",
        "だ",
    ];
    for token in tokens {
        let Some(word) = token["word"]
            .as_str()
            .filter(|w| w.encode_utf16().count() <= 64)
        else {
            continue;
        };
        if token
            .get("conf")
            .is_some_and(|c| !c.as_f64().is_some_and(|v| v.is_finite() && v >= 0.55))
        {
            continue;
        }
        let word: String = word.nfkc().collect();
        if valid_stone_word(&word, maximum) && !FUNCTION.contains(&word.as_str()) {
            return Some(word);
        }
    }
    None
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub fn normalise(text: &str) -> String {
    text.nfkc()
        .flat_map(char::to_lowercase)
        .filter(|c| !c.is_whitespace() && !"、。！!？?・".contains(*c))
        .map(|c| {
            if ('ァ'..='ヶ').contains(&c) {
                char::from_u32(c as u32 - 0x60).unwrap()
            } else {
                c
            }
        })
        .collect()
}
pub fn matches(text: &str, job: &Value, final_result: bool) -> bool {
    if text.encode_utf16().count() > 4096 || job["kind"] == "ng" && !final_result {
        return false;
    }
    let words = job["words"].as_array();
    let default = words.is_none_or(Vec::is_empty)
        || words.and_then(|ws| ws.first()).is_some_and(|v| v == "変身");
    if job["kind"] != "ng" && default {
        let n: String = text
            .nfkc()
            .filter(|c| !c.is_whitespace() && !"、。！!？?・".contains(*c))
            .collect();
        if n.contains("変身")
            || n.contains("へんしん")
            || n.contains("ヘンシン")
            || (final_result && n == "返信")
        {
            return true;
        }
    }
    let n = normalise(text);
    words
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|w| {
            let w = normalise(w);
            w.encode_utf16().count() >= 2 && n.contains(&w)
        })
}
#[derive(Clone, Default)]
struct Config {
    session: String,
    inputs: HashMap<String, (u64, Vec<Value>)>,
}
pub enum Event {
    Ready(String, u64),
    Word(String, u64, u64, String, String),
    Error(String),
}
struct Input {
    key: String,
    pcm: Vec<f32>,
}
struct Worker {
    config: Arc<Mutex<Config>>,
    audio: mpsc::SyncSender<Input>,
    events: mpsc::Receiver<Event>,
    stop: Arc<AtomicBool>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}
#[derive(Default)]
pub struct Speech {
    worker: Option<Worker>,
    path: PathBuf,
}
impl Speech {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            ..Default::default()
        }
    }
    pub fn configure(&mut self, state: &Value, inputs: Vec<(String, u64)>) {
        let mut config = Config {
            session: state["session"].as_str().unwrap_or("").into(),
            ..Default::default()
        };
        for (key, id) in inputs {
            let jobs: Vec<_> = state["players"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["playerId"] == id)
                .cloned()
                .collect();
            if !jobs.is_empty() {
                config.inputs.insert(key, (id, jobs));
            }
        }
        if config.inputs.is_empty() {
            if let Some(w) = &self.worker {
                *w.config.lock().unwrap() = config;
            }
            return;
        }
        if self.worker.is_none() {
            let shared = Arc::new(Mutex::new(Config::default()));
            let owned = shared.clone();
            let (audio, rx) = mpsc::sync_channel::<Input>(32);
            let (tx, events) = mpsc::sync_channel(64);
            let stop = Arc::new(AtomicBool::new(false));
            let cancel = stop.clone();
            let path = self.path.clone();
            std::thread::Builder::new()
                .name("native-speech".into())
                .spawn(move || run(path, owned, rx, tx, cancel))
                .expect("speech worker");
            self.worker = Some(Worker {
                config: shared,
                audio,
                events,
                stop,
            });
        }
        *self.worker.as_ref().unwrap().config.lock().unwrap() = config;
    }
    pub fn sender(&self) -> Option<Sender> {
        self.worker.as_ref().map(|w| Sender {
            config: w.config.clone(),
            audio: w.audio.clone(),
        })
    }
    pub fn events(&self) -> Vec<Event> {
        self.worker
            .as_ref()
            .map(|w| w.events.try_iter().take(64).collect())
            .unwrap_or_default()
    }
}
#[derive(Clone)]
pub struct Sender {
    config: Arc<Mutex<Config>>,
    audio: mpsc::SyncSender<Input>,
}
impl Sender {
    pub fn push(&self, key: &str, pcm: &[f32]) {
        if pcm.len() > 5760 || !self.config.lock().unwrap().inputs.contains_key(key) {
            return;
        }
        let _ = self.audio.try_send(Input {
            key: key.into(),
            pcm: pcm
                .iter()
                .map(|v| (v * 32768.).clamp(-32768., 32767.))
                .collect(),
        });
    }
}
type Ptr = *mut c_void;
struct Api {
    module: windows_sys::Win32::Foundation::HMODULE,
    model_new: unsafe extern "C" fn(*const c_char) -> Ptr,
    model_free: unsafe extern "C" fn(Ptr),
    new: unsafe extern "C" fn(Ptr, f32) -> Ptr,
    free: unsafe extern "C" fn(Ptr),
    accept: unsafe extern "C" fn(Ptr, *const f32, i32) -> i32,
    result: unsafe extern "C" fn(Ptr) -> *const c_char,
    partial: unsafe extern "C" fn(Ptr) -> *const c_char,
    final_result: unsafe extern "C" fn(Ptr) -> *const c_char,
    set_words: unsafe extern "C" fn(Ptr, i32),
}
impl Api {
    fn load(path: &Path) -> Result<Self, String> {
        use windows_sys::Win32::System::LibraryLoader::*;
        let file = path.join("libvosk.dll");
        let wide: Vec<_> = file
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let module = unsafe {
            LoadLibraryExW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            )
        };
        if module.is_null() {
            return Err(format!(
                "音声認識ライブラリを読み込めません: {}",
                std::io::Error::last_os_error()
            ));
        }
        macro_rules! load {
            ($name:literal) => {{
                let p = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) }
                    .ok_or(concat!("Missing ", $name))?;
                unsafe { std::mem::transmute(p) }
            }};
        }
        let log: unsafe extern "C" fn(i32) = load!("vosk_set_log_level");
        unsafe { log(-1) };
        Ok(Self {
            module,
            model_new: load!("vosk_model_new"),
            model_free: load!("vosk_model_free"),
            new: load!("vosk_recognizer_new"),
            free: load!("vosk_recognizer_free"),
            accept: load!("vosk_recognizer_accept_waveform_f"),
            result: load!("vosk_recognizer_result"),
            partial: load!("vosk_recognizer_partial_result"),
            final_result: load!("vosk_recognizer_final_result"),
            set_words: load!("vosk_recognizer_set_words"),
        })
    }
}
impl Drop for Api {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::FreeLibrary(self.module);
        }
    }
}
struct Decoder {
    ptr: Ptr,
    signature: String,
    jobs: Vec<Value>,
    partial_at: Option<Instant>,
}
fn run(
    path: PathBuf,
    config: Arc<Mutex<Config>>,
    audio: mpsc::Receiver<Input>,
    events: mpsc::SyncSender<Event>,
    stop: Arc<AtomicBool>,
) {
    let mut api: Option<Api> = None;
    let mut model: Ptr = std::ptr::null_mut();
    let mut decoders: HashMap<String, Decoder> = HashMap::new();
    let mut session = String::new();
    let mut handled = HashSet::new();
    let mut retry = Instant::now();
    let mut ready = HashSet::new();
    let mut last_ready = Instant::now() - Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        let c = config.lock().unwrap().clone();
        let t = now();
        let enabled = !c.inputs.is_empty();
        let changed = session != c.session;
        if changed || !enabled {
            if let Some(a) = &api {
                for (_, d) in decoders.drain() {
                    unsafe { (a.free)(d.ptr) }
                }
            }
            handled.clear();
            ready.clear();
            session = c.session.clone();
            if !enabled {
                if let Some(a) = &api {
                    if !model.is_null() {
                        unsafe { (a.model_free)(model) }
                        model = std::ptr::null_mut();
                    }
                }
                api = None;
            }
        }
        if enabled && model.is_null() && Instant::now() >= retry {
            let loaded = (|| {
                let a = Api::load(&path)?;
                let model_path = CString::new(path.join("model").to_string_lossy().as_bytes())
                    .map_err(|e| e.to_string())?;
                let m = unsafe { (a.model_new)(model_path.as_ptr()) };
                if m.is_null() {
                    return Err("日本語音声認識モデルを読み込めません".to_string());
                }
                Ok((a, m))
            })();
            match loaded {
                Ok((a, m)) => {
                    api = Some(a);
                    model = m;
                }
                Err(e) => {
                    let _ = events.try_send(Event::Error(e));
                    retry = Instant::now() + Duration::from_secs(10);
                }
            }
        }
        if let Some(a) = &api {
            if last_ready.elapsed() >= Duration::from_millis(200) {
                ready.clear();
                last_ready = Instant::now();
            }
            let active: HashMap<_, _> = c
                .inputs
                .iter()
                .map(|(key, (id, jobs))| {
                    if ready.insert(*id) {
                        let _ = events.try_send(Event::Ready(c.session.clone(), *id));
                    }
                    let jobs: Vec<_> = jobs
                        .iter()
                        .filter(|j| {
                            j["request"].as_u64().is_some_and(|r| r > 0)
                                && j["expires"].as_u64().unwrap_or(0) > t
                                && !handled.contains(&format!(
                                    "{}:{}:{}",
                                    j["playerId"], j["kind"], j["request"]
                                ))
                        })
                        .cloned()
                        .collect();
                    (key.clone(), (*id, jobs))
                })
                .filter(|(_, (_, jobs))| !jobs.is_empty())
                .collect();
            decoders.retain(|key, d| {
                let keep = active.get(key).is_some_and(|(_, jobs)| {
                    d.signature == jobs.iter().map(Value::to_string).collect::<String>()
                });
                if !keep {
                    unsafe { (a.free)(d.ptr) }
                }
                keep
            });
            for (key, (_, jobs)) in &active {
                if !decoders.contains_key(key) {
                    let ptr = unsafe { (a.new)(model, 48000.) };
                    if !ptr.is_null() {
                        unsafe { (a.set_words)(ptr, 1) };
                        decoders.insert(
                            key.clone(),
                            Decoder {
                                ptr,
                                signature: jobs.iter().map(Value::to_string).collect(),
                                jobs: jobs.clone(),
                                partial_at: None,
                            },
                        );
                    }
                }
            }
        }
        match audio.recv_timeout(Duration::from_millis(20)) {
            Ok(input) => {
                let Some(a) = &api else { continue };
                let Some(d) = decoders.get_mut(&input.key) else {
                    continue;
                };
                let current = config.lock().unwrap();
                if current.session != c.session || !current.inputs.contains_key(&input.key) {
                    continue;
                }
                drop(current);
                let final_result =
                    unsafe { (a.accept)(d.ptr, input.pcm.as_ptr(), input.pcm.len() as i32) } > 0;
                let result = unsafe {
                    if final_result {
                        (a.result)(d.ptr)
                    } else {
                        (a.partial)(d.ptr)
                    }
                };
                if result.is_null() {
                    continue;
                }
                let bytes = unsafe { CStr::from_ptr(result) }.to_bytes();
                if bytes.len() > 32768 {
                    continue;
                }
                let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
                let text = value[if final_result { "text" } else { "partial" }]
                    .as_str()
                    .unwrap_or("");
                for j in &d.jobs {
                    if j["expires"].as_u64().unwrap_or(0) <= now() {
                        continue;
                    }
                    let key = format!("{}:{}:{}", j["playerId"], j["kind"], j["request"]);
                    if handled.contains(&key) {
                        continue;
                    }
                    let word = if j["kind"] == "stone" {
                        recognised_stone_word(
                            &value["result"],
                            final_result,
                            j["maxCharacters"].as_u64().unwrap_or(0) as usize,
                        )
                    } else {
                        None
                    };
                    if if j["kind"] == "stone" {
                        word.is_none()
                    } else {
                        !matches(text, j, final_result)
                    } {
                        if j["kind"] == "hero" {
                            d.partial_at = None;
                        }
                        continue;
                    }
                    if !final_result {
                        let at = d.partial_at.get_or_insert(Instant::now());
                        if at.elapsed() < Duration::from_millis(180) {
                            continue;
                        }
                    }
                    handled.insert(key);
                    let _ = events.try_send(Event::Word(
                        c.session.clone(),
                        j["playerId"].as_u64().unwrap_or(256),
                        j["request"].as_u64().unwrap_or(0),
                        j["kind"].as_str().unwrap_or("").into(),
                        word.unwrap_or_default(),
                    ));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) => {}
        }
    }
    if let Some(a) = &api {
        for (_, d) in decoders {
            unsafe { (a.free)(d.ptr) }
        }
        if !model.is_null() {
            unsafe { (a.model_free)(model) }
        }
    }
}
pub fn probe(path: &Path, pcm_path: Option<&Path>) -> Result<Value, String> {
    let api = Api::load(path)?;
    let model_path =
        CString::new(path.join("model").to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    let model = unsafe { (api.model_new)(model_path.as_ptr()) };
    if model.is_null() {
        return Err("Model did not load".into());
    }
    let decoder = unsafe { (api.new)(model, 48000.) };
    if decoder.is_null() {
        unsafe { (api.model_free)(model) }
        return Err("Recognizer did not initialize".into());
    }
    let mut texts = Vec::new();
    if let Some(path) = pcm_path {
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() > 2 * 1024 * 1024 || bytes.len() % 4 != 0 {
            return Err("Speech fixture exceeds its limit".into());
        }
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        if samples.iter().any(|v| !v.is_finite() || v.abs() > 1.) {
            return Err("Invalid speech fixture samples".into());
        }
        for block in samples.chunks(960) {
            let pcm: Vec<_> = block.iter().map(|v| v * 32768.).collect();
            let complete = unsafe { (api.accept)(decoder, pcm.as_ptr(), pcm.len() as i32) } > 0;
            if complete {
                let value: Value = serde_json::from_slice(
                    unsafe { CStr::from_ptr((api.result)(decoder)) }.to_bytes(),
                )
                .unwrap_or(Value::Null);
                if let Some(s) = value["text"].as_str() {
                    texts.push(s.to_string());
                }
            }
        }
        let value: Value = serde_json::from_slice(
            unsafe { CStr::from_ptr((api.final_result)(decoder)) }.to_bytes(),
        )
        .unwrap_or(Value::Null);
        if let Some(s) = value["text"].as_str() {
            texts.push(s.to_string());
        }
    }
    for _ in 0..20 {
        let silence = [0.; 960];
        unsafe {
            (api.accept)(decoder, silence.as_ptr(), 960);
        }
    }
    let result = unsafe { (api.partial)(decoder) };
    let value: Value = if result.is_null() {
        Value::Null
    } else {
        serde_json::from_slice(unsafe { CStr::from_ptr(result) }.to_bytes()).unwrap_or(Value::Null)
    };
    unsafe {
        (api.free)(decoder);
        (api.model_free)(model)
    }
    Ok(
        json!({"passed":if pcm_path.is_some(){texts.iter().any(|s|!s.is_empty())}else{value["partial"]==""},"nativeModelLoaded":true,"recognizers":1,"silenceSeconds":0.4,"recognizedText":texts.join(" ")}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn japanese_unicode_normalization_and_final_word_rules() {
        let hero = json!({"kind":"hero","words":["変身"]});
        assert!(matches(" ヘンシン！", &hero, false));
        assert!(matches("返信", &hero, true));
        assert!(!matches("返信", &hero, false));
        let ng = json!({"kind":"ng","words":["バナナ"]});
        assert!(matches("ﾊﾞﾅﾅ です", &ng, true));
        assert!(!matches("ばなな", &ng, false));
        assert!(!matches("ばな", &ng, true));
    }
    #[test]
    fn stone_sends_only_confident_final_tokens_with_exact_unicode_bounds() {
        assert!(valid_stone_word("タヌキ", 3));
        assert!(valid_stone_word("𠮷", 1));
        for word in ["", "ｱ", "あ い", "猫。", "①", "é\u{301}", "\u{0301}", "Ⅲ"] {
            assert!(!valid_stone_word(word, 12), "{word}");
        }
        assert!(!valid_stone_word("タヌキ", 2));
        let tokens =
            json!([{"word":"はい","conf":0.99},{"word":"猫","conf":0.5},{"word":"ﾊﾞﾅﾅ","conf":0.8}]);
        assert_eq!(
            recognised_stone_word(&tokens, true, 3),
            Some("バナナ".into())
        );
        assert!(recognised_stone_word(&tokens, false, 3).is_none());
        assert!(recognised_stone_word(&json!([{"word":"猫 犬"}]), true, 12).is_none());
        assert!(recognised_stone_word(&json!([{"word":"猫","conf":"0.9"}]), true, 12).is_none());
        assert!(recognised_stone_word(&json!(vec![json!({"word":"猫"}); 65]), true, 12).is_none());
    }
}
