use base64::Engine;
use serde_json::{json, Value};
use std::{
    ffi::{c_char, c_void, CStr, CString},
    io::{self, BufRead, Read, Write},
    time::Instant,
};
use unicode_normalization::UnicodeNormalization;
extern "C" {
    fn tbcl_speech_new(root: *const c_char) -> *mut c_void;
    fn tbcl_speech_run(engine: *mut c_void, pcm: *const f32, n: i32, use_vad: i32)
        -> *const c_char;
    fn tbcl_speech_ranges(engine: *mut c_void, pcm: *const f32, n: i32) -> *const c_char;
    fn tbcl_speech_free(engine: *mut c_void);
}
fn valid_word(word: &str, max: usize) -> bool {
    (1..=max).contains(&word.chars().count())
        && word
            .chars()
            .all(|c| c.is_alphanumeric() || c == 'ー' || c == '々')
}
fn word(text: &str, max: usize) -> Option<String> {
    let text: String = text.nfkc().collect();
    let function = [
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
    tinysegmenter::tokenize(&text)
        .into_iter()
        .find(|w| valid_word(w, max) && !function.contains(&w.as_str()))
}
fn wav(bytes: &[u8]) -> Result<Vec<f32>, &'static str> {
    if bytes.len() < 3244 || bytes.len() > 320044 || bytes.len() % 2 != 0 {
        return Err("audio_size");
    }
    let u16_at = |n| u16::from_le_bytes(bytes[n..n + 2].try_into().unwrap());
    let u32_at = |n| u32::from_le_bytes(bytes[n..n + 4].try_into().unwrap());
    if &bytes[..4] != b"RIFF"
        || u32_at(4) as usize != bytes.len() - 8
        || &bytes[8..16] != b"WAVEfmt "
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || u32_at(24) != 16000
        || u32_at(28) != 32000
        || u16_at(32) != 2
        || u16_at(34) != 16
        || &bytes[36..40] != b"data"
        || u32_at(40) as usize != bytes.len() - 44
    {
        return Err("audio_format");
    }
    Ok(bytes[44..]
        .chunks_exact(2)
        .map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.)
        .collect())
}
struct Runtime(*mut c_void);
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe { tbcl_speech_free(self.0) }
    }
}
fn response(runtime: &Runtime, request: Value) -> Result<Value, &'static str> {
    let id = request["id"]
        .as_str()
        .filter(|id| id.len() <= 160)
        .ok_or("id")?;
    let maximum = request["maximum"]
        .as_u64()
        .filter(|n| (1..=12).contains(n))
        .ok_or("maximum")? as usize;
    let encoded = request["wav"]
        .as_str()
        .filter(|s| s.len() <= 426728)
        .ok_or("audio_size")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "audio_encoding")?;
    let pcm = wav(&bytes)?;
    let start = Instant::now();
    if pcm.iter().map(|v| v * v).sum::<f32>() / (pcm.len() as f32) < 0.000001 {
        return Ok(json!({"id":id,"text":"","word":null,"ms":0}));
    }
    if request["engine"] == "vad-only" {
        let result = unsafe { tbcl_speech_ranges(runtime.0, pcm.as_ptr(), pcm.len() as i32) };
        if result.is_null() {
            return Err("vad");
        }
        let ranges: Value = serde_json::from_str(
            unsafe { CStr::from_ptr(result) }
                .to_str()
                .map_err(|_| "encoding")?,
        )
        .map_err(|_| "segments")?;
        return Ok(json!({"id":id,"segments":ranges,"ms":start.elapsed().as_millis()}));
    }
    let result = unsafe {
        tbcl_speech_run(
            runtime.0,
            pcm.as_ptr(),
            pcm.len() as i32,
            i32::from(request["vad"] != false),
        )
    };
    if result.is_null() {
        return Err("inference");
    }
    let text = unsafe { CStr::from_ptr(result) }
        .to_str()
        .map_err(|_| "encoding")?;
    if text.len() > 16384 {
        return Err("response_size");
    }
    Ok(json!({"id":id,"text":text,"word":word(text,maximum),"ms":start.elapsed().as_millis()}))
}
fn main() {
    let root = std::env::args().nth(1).expect("speech cache root required");
    let root = CString::new(root).unwrap();
    let ptr = unsafe { tbcl_speech_new(root.as_ptr()) };
    if ptr.is_null() {
        std::process::exit(2);
    }
    let runtime = Runtime(ptr);
    let mut reader = io::BufReader::new(io::stdin().lock());
    loop {
        let mut bytes = Vec::new();
        let size = Read::by_ref(&mut reader)
            .take(440001)
            .read_until(b'\n', &mut bytes)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        if size > 440000 || bytes.last() != Some(&b'\n') {
            break;
        }
        let request: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let id = request["id"].clone();
        let output =
            response(&runtime, request).unwrap_or_else(|error| json!({"id":id,"error":error}));
        println!("{output}");
        let _ = io::stdout().flush();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn japanese_words() {
        assert_eq!(
            word("インポスターが来た", 8).as_deref(),
            Some("インポスター")
        );
        assert_eq!(word("えっと、猫です", 8).as_deref(), Some("猫"));
        assert!(word("インポスター", 3).is_none());
    }
    #[test]
    fn invalid_audio() {
        assert!(wav(&vec![0; 3244]).is_err());
        assert!(wav(&vec![0; 320046]).is_err());
    }
}
