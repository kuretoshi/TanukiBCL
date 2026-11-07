//! Application services shared by visible and headless Rust modes. Network
//! mutations are reached only through their original, user-operated UI actions.
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const ATTACHMENT_LIMIT: usize = 24 * 1024 * 1024;
const LOG_LIMIT: usize = 1024 * 1024;
const LOGS: [&str; 3] = ["backend.log", "frontend.log", "memory.jsonl"];
pub struct Services {
    authorized: AtomicBool,
    next_attempt: Mutex<Instant>,
    selected: Mutex<HashSet<PathBuf>>,
}
impl Default for Services {
    fn default() -> Self {
        Self {
            authorized: AtomicBool::new(false),
            next_attempt: Mutex::new(Instant::now()),
            selected: Mutex::new(HashSet::new()),
        }
    }
}
fn text(value: &Value, max: usize) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= max)
}
fn tail(path: &Path, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    let length = file.metadata()?.len();
    if length > limit as u64 {
        file.seek(SeekFrom::End(-(limit as i64)))?;
    }
    let mut bytes = Vec::new();
    file.take(limit as u64).read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn logs(data: &Path, limit: usize) -> String {
    LOGS.iter()
        .filter_map(|name| tail(&data.join("logs").join(name), limit).ok())
        .filter(|v| !v.is_empty())
        .map(|v| String::from_utf8_lossy(&v).into_owned())
        .collect::<Vec<_>>()
        .join("\n")
}
fn valid_endpoint(endpoint: &str) -> bool {
    tauri::Url::parse(endpoint).is_ok_and(|u| {
        u.scheme() == "https"
            && u.host_str().is_some()
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none()
    })
}
fn auth_response(status: u16, bytes: &[u8]) -> &'static str {
    if status == 401 {
        return "denied";
    }
    if status != 200 || bytes.len() > 1024 {
        return "unavailable";
    }
    match serde_json::from_slice::<Value>(bytes) {
        Ok(v) if v["authorized"] == true => "authorized",
        Ok(_) => "denied",
        Err(_) => "unavailable",
    }
}
fn normalize_bans(value: Value) -> Value {
    if !value["bans"].is_array() || !value["pending"].is_array() {
        return json!({"error":"BAN一覧を取得できませんでした。"});
    }
    json!({"bans":value["bans"],"pending":value["pending"],"history":value["history"].as_array().cloned().unwrap_or_default(),"historyTotal":value["historyTotal"].as_u64().unwrap_or(0),"historyAvailable":value["history"].is_array(),"ipBansAvailable":value["ipBansAvailable"]==true})
}
fn clean(value: &Value, limit: usize) -> String {
    // JavaScript limits use UTF-16 code units. Do not split a surrogate pair.
    let source = value.as_str().unwrap_or("").trim().replace("\r\n", "\n");
    let mut remaining = limit;
    source
        .chars()
        .take_while(|c| {
            let width = c.len_utf16();
            if width > remaining {
                false
            } else {
                remaining -= width;
                true
            }
        })
        .collect()
}
fn inquiry_payload(value: &Value) -> Result<Value, String> {
    if value["publicIssueAcknowledged"] != true {
        return Err("公開される内容を確認してください。".into());
    }
    let subject = clean(&value["subject"], 100);
    let body = clean(&value["body"], 1800);
    if subject.is_empty() || body.is_empty() {
        return Err("件名と本文を入力してください。".into());
    }
    let tag = value["tag"]
        .as_str()
        .filter(|s| ["question", "bug", "request"].contains(s))
        .ok_or("問い合わせの種類を確認してください。")?;
    Ok(
        json!({"product":"tanuki","public_issue_consent":true,"tag":tag,"subject":subject,"body":body}),
    )
}
fn issue_url(value: &Value) -> Option<&str> {
    let url = value["issue_url"].as_str()?;
    let id = url.strip_prefix("https://github.com/kuretoshi/TanukiBCL/issues/")?;
    (!id.is_empty() && id.bytes().all(|c| c.is_ascii_digit())).then_some(url)
}
fn multipart(payload: &Value, files: &[(String, Vec<u8>)]) -> (String, Vec<u8>) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let boundary = format!("----TanukiBCLTauriInquiry{stamp:x}");
    let mut body=format!("--{boundary}\r\nContent-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json\r\n\r\n{payload}\r\n").into_bytes();
    for (i, (name, bytes)) in files.iter().enumerate() {
        let filename = name.replace(['\r', '\n', '"'], "_");
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files[{i}]\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}
impl Services {
    pub fn authorized(&self) -> bool {
        self.authorized.load(Ordering::Relaxed)
    }
    pub fn request(
        &self,
        target: &str,
        channel: &str,
        args: &[Value],
        data: &Path,
        client: &Client,
    ) -> Option<Result<Value, String>> {
        let first = args.first().unwrap_or(&Value::Null);
        Some(match channel {
            "OPEN_DEBUG" => Ok(json!(self.authenticate(target, first, client))),
            "OPEN_PLAYER_HISTORY" => Ok(json!(target == "debug" && self.authorized())),
            "debug:get-logs" => Ok(json!(if target == "debug" && self.authorized() {
                logs(data, 65536)
            } else {
                String::new()
            })),
            "tauri:save-log" => {
                if target != "debug" || !self.authorized() {
                    Err("Not authorized".into())
                } else if let Some(destination) = text(first, 32767) {
                    fs::write(destination, logs(data, 65536))
                        .map(|_| json!({"status":"saved"}))
                        .map_err(|e| e.to_string())
                } else {
                    Err("Invalid destination".into())
                }
            }
            "debug:player-bans" => {
                if !["debug", "player-history"].contains(&target) || !self.authorized() {
                    Ok(json!({"error":"デバッグ画面から操作してください。"}))
                } else {
                    Ok(self.manage_bans(first, client))
                }
            }
            "tauri:attachments" => self.attachments(first),
            "SUBMIT_INQUIRY" => {
                if target != "settings" {
                    Err("設定画面から操作してください。".into())
                } else {
                    self.inquiry(first, data, client)
                }
            }
            _ => return None,
        })
    }
    fn authenticate(&self, target: &str, password: &Value, client: &Client) -> &'static str {
        if target != "settings" || text(password, 1024).is_none() {
            return "denied";
        }
        let mut next = self.next_attempt.lock().unwrap();
        if Instant::now() < *next {
            return "denied";
        }
        *next = Instant::now() + Duration::from_secs(10);
        drop(next);
        let endpoint = std::env::var("TANUKI_DEBUG_AUTH_URL")
            .unwrap_or_else(|_| "https://debug-auth.kuretoshi.work/v1/debug-auth/verify".into());
        if !valid_endpoint(&endpoint) {
            return "unavailable";
        }
        let result = (|| -> Result<&'static str, String> {
            let response = client
                .post(endpoint)
                .json(&json!({"password":password}))
                .send()
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            response
                .take(1025)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            Ok(auth_response(status, &bytes))
        })();
        let result = result.unwrap_or("unavailable");
        if result == "authorized" {
            self.authorized.store(true, Ordering::Relaxed);
        }
        result
    }
    fn manage_bans(&self, value: &Value, client: &Client) -> Value {
        if !value.is_object() {
            return json!({"error":"入力内容を確認してください。"});
        }
        if text(&value["password"], 1024).is_none() {
            return json!({"error":"管理者パスワードを入力してください。"});
        }
        if !value["action"].as_str().is_some_and(|s| {
            [
                "list",
                "add",
                "remove",
                "add-name",
                "remove-name",
                "add-history",
                "add-ip",
                "add-history-ip",
                "remove-ip",
            ]
            .contains(&s)
        }) {
            return json!({"error":"操作を確認してください。"});
        }
        match super::http::post(
            client,
            "https://debug-auth.kuretoshi.work/v1/player-bans/manage",
            value,
        ) {
            Ok(value) => normalize_bans(value),
            Err(error) => json!({"error":error}),
        }
    }
    fn attachments(&self, value: &Value) -> Result<Value, String> {
        let paths = value
            .as_array()
            .filter(|p| p.len() <= 10)
            .ok_or("Invalid selection")?;
        let mut output = Vec::new();
        let mut selected = self.selected.lock().unwrap();
        for path in paths {
            let raw = text(path, 32767).ok_or("Invalid file")?;
            let canonical = fs::canonicalize(raw).map_err(|e| e.to_string())?;
            let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
            if !metadata.is_file() {
                return Err("Invalid file".into());
            }
            selected.insert(canonical);
            output.push(json!({"path":raw,"name":Path::new(raw).file_name().unwrap_or_default().to_string_lossy(),"size":metadata.len()}));
        }
        Ok(json!(output))
    }
    fn inquiry(&self, value: &Value, data: &Path, client: &Client) -> Result<Value, String> {
        let payload = inquiry_payload(value)?;
        let paths = value["attachmentPaths"]
            .as_array()
            .filter(|a| a.len() <= 10)
            .ok_or("Invalid attachments")?;
        let mut files = Vec::new();
        let mut total = 0;
        for path in paths {
            let canonical = fs::canonicalize(text(path, 32767).ok_or("Invalid attachment")?)
                .map_err(|e| e.to_string())?;
            if !self.selected.lock().unwrap().contains(&canonical) {
                return Err("ファイル選択から添付してください。".into());
            }
            let file = fs::File::open(&canonical).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("Invalid attachment".into());
            }
            let mut bytes = Vec::new();
            file.take((ATTACHMENT_LIMIT - total + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            total += bytes.len();
            if total > ATTACHMENT_LIMIT {
                return Err("添付ファイルの合計サイズは24MB以下にしてください。".into());
            }
            files.push((
                canonical
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                bytes,
            ));
        }
        for name in LOGS {
            if let Ok(bytes) = tail(&data.join("logs").join(name), LOG_LIMIT) {
                if !bytes.is_empty() {
                    total += bytes.len();
                    if total > ATTACHMENT_LIMIT {
                        return Err("添付ファイルの合計サイズは24MB以下にしてください。".into());
                    }
                    files.push((name.into(), bytes));
                }
            }
        }
        let endpoint = std::env::var("BETTERCREWLINK_INQUIRY_URL")
            .unwrap_or_else(|_| "https://debug-auth.kuretoshi.work/v1/inquiries".into());
        if !valid_endpoint(&endpoint) {
            return Err("Invalid inquiry endpoint".into());
        }
        let request = client.post(endpoint);
        let request = if files.is_empty() {
            request.json(&payload)
        } else {
            let (content_type, body) = multipart(&payload, &files);
            request.header("Content-Type", content_type).body(body)
        };
        let response = request
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("問い合わせの送信に失敗しました。{e}"))?;
        let mut bytes = Vec::new();
        response
            .take(8193)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 8192 {
            return Err("Invalid inquiry response".into());
        }
        let result: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        issue_url(&result)
            .map(|u| json!(u))
            .ok_or("問い合わせの送信に失敗しました。".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debug_auth_never_accepts_failure_redirect_or_unbounded_responses() {
        assert_eq!(auth_response(200, br#"{"authorized":true}"#), "authorized");
        assert_eq!(auth_response(200, br#"{"authorized":"true"}"#), "denied");
        assert_eq!(auth_response(401, b""), "denied");
        assert_eq!(auth_response(302, br#"{"authorized":true}"#), "unavailable");
        assert_eq!(auth_response(200, &[b' '; 1025]), "unavailable");
        assert!(!valid_endpoint("http://example.com"));
        assert!(!valid_endpoint("https://user:pass@example.com"));
    }
    #[test]
    fn inquiry_requires_explicit_consent_and_preserves_bounded_unicode_text() {
        let mut input = json!({"subject":" 題名\r\n ","body":"😀".repeat(1000),"tag":"bug","publicIssueAcknowledged":false});
        assert!(inquiry_payload(&input).is_err());
        input["publicIssueAcknowledged"] = json!(true);
        let payload = inquiry_payload(&input).unwrap();
        assert_eq!(payload["subject"], "題名");
        assert_eq!(
            payload["body"].as_str().unwrap().encode_utf16().count(),
            1800
        );
        assert!(issue_url(
            &json!({"issue_url":"https://github.com/kuretoshi/TanukiBCL/issues/12"})
        )
        .is_some());
        assert!(issue_url(
            &json!({"issue_url":"https://github.com/kuretoshi/TanukiBCL/issues/12?x=1"})
        )
        .is_none());
    }
    #[test]
    fn multipart_prevents_filename_header_injection() {
        let (_, body) = multipart(
            &json!({"subject":"test"}),
            &[("x\r\nInjected: \"yes\".txt".into(), b"contents".to_vec())],
        );
        let output = String::from_utf8(body).unwrap();
        assert!(output.contains("x__Injected: _yes_.txt"));
        assert!(output.contains("contents\r\n--"));
    }
    #[test]
    fn privileged_services_are_scoped_to_authenticated_windows() {
        let services = Services::default();
        let client = super::super::http::client().unwrap();
        assert_eq!(
            services
                .request(
                    "main",
                    "OPEN_DEBUG",
                    &[json!("password")],
                    Path::new("."),
                    &client
                )
                .unwrap()
                .unwrap(),
            "denied"
        );
        assert_eq!(
            services
                .request("settings", "debug:get-logs", &[], Path::new("."), &client)
                .unwrap()
                .unwrap(),
            ""
        );
        assert_eq!(
            services
                .request("debug", "OPEN_PLAYER_HISTORY", &[], Path::new("."), &client)
                .unwrap()
                .unwrap(),
            false
        );
    }
}
