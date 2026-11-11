//! Updates only the separate Tauri product. Electron installers are never
//! candidates. Downloads stream to disk and are verified again before launch.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
const REPOSITORY: &str = "kuretoshi/TanukiBCL";
const LIMIT: u64 = 1024 * 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Candidate {
    version: String,
    filename: String,
    url: String,
    size: u64,
    sha256: Option<String>,
    checksum: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Staged {
    candidate: Candidate,
    sha256: String,
}
pub struct Updater {
    state: Mutex<Value>,
    candidate: Mutex<Option<Candidate>>,
    busy: AtomicBool,
}
impl Default for Updater {
    fn default() -> Self {
        Self {
            state: Mutex::new(json!({"state":"idle","message":"更新を確認できます"})),
            candidate: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }
}
impl Updater {
    fn publish(&self, app: &AppHandle, value: Value) {
        *self.state.lock().unwrap() = value.clone();
        for target in ["main", "settings"] {
            let _ = app.emit_to(
                target,
                "backend-ipc",
                json!({"channel":"AUTO_UPDATER_STATE","args":[value]}),
            );
        }
    }
    pub fn request(&self, action: &str, data: &Path, app: &AppHandle) -> Result<Value, String> {
        if action == "updater:get-state" {
            return Ok(self.state.lock().unwrap().clone());
        }
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err("更新処理を実行しています".into());
        }
        struct Guard<'a>(&'a AtomicBool);
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _guard = Guard(&self.busy);
        let result = match action {
            "updater:check" => self.check(app),
            "update-app" => self.download(data, app),
            "RESTART_AND_UPDATE" => self.install(data, app),
            _ => Err("Unknown updater command".into()),
        };
        match result {
            Ok(()) => Ok(self.state.lock().unwrap().clone()),
            Err(error) => {
                self.publish(app, json!({"state":"error","error":error,"message":error}));
                Err(error)
            }
        }
    }
    fn check(&self, app: &AppHandle) -> Result<(), String> {
        self.publish(
            app,
            json!({"state":"checking","message":"Rust版の更新を確認しています"}),
        );
        let client = client()?;
        let url = format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=20");
        let response = get(&client, &url)?;
        let mut bytes = Vec::new();
        response
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 8 * 1024 * 1024 {
            return Err("Update release response exceeds limit".into());
        }
        let releases: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let candidate = select(&releases, env!("CARGO_PKG_VERSION"))?;
        *self.candidate.lock().unwrap() = candidate.clone();
        self.publish(app,if let Some(c)=candidate{json!({"state":"available","message":format!("Rust版 {} を利用できます",c.version),"info":{"version":c.version,"releaseName":c.filename}})}else{json!({"state":"not-available","message":"現在利用できる新しいRust版はありません"})});
        Ok(())
    }
    fn download(&self, data: &Path, app: &AppHandle) -> Result<(), String> {
        let candidate = self
            .candidate
            .lock()
            .unwrap()
            .clone()
            .ok_or("先に更新を確認してください")?;
        let client = client()?;
        let expected = if let Some(hash) = &candidate.sha256 {
            hash.clone()
        } else {
            let address = candidate
                .checksum
                .as_deref()
                .ok_or("更新ファイルのチェックサムがありません")?;
            let mut bytes = Vec::new();
            get(&client, address)?
                .take(4097)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > 4096 {
                return Err("Checksum response exceeds limit".into());
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| "Invalid checksum UTF8")?;
            let parts: Vec<_> = text.split_whitespace().collect();
            let hash = parts
                .first()
                .copied()
                .filter(|v| valid_hash(v))
                .ok_or("Invalid update checksum")?;
            if parts
                .get(1)
                .is_some_and(|v| v.trim_start_matches('*') != candidate.filename)
            {
                return Err("Update checksum filename mismatch".into());
            }
            hash.to_ascii_lowercase()
        };
        let directory = data.join("updates");
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let destination = directory.join(&candidate.filename);
        if destination.is_file() && file_hash(&destination, candidate.size)? == expected {
            self.finish_download(&directory, &candidate, &expected, app)?;
            return Ok(());
        }
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let temporary = directory.join(format!(
            "download-{:016x}.partial",
            u64::from_le_bytes(random)
        ));
        let mut guard = Temporary {
            path: temporary.clone(),
            created: false,
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        guard.created = true;
        let response = get(&client, &candidate.url)?;
        if response
            .content_length()
            .is_some_and(|length| length != candidate.size)
        {
            return Err("Update download size differs from release metadata".into());
        }
        let mut last = Instant::now() - Duration::from_secs(1);
        let hash = stream(response, &mut file, candidate.size, |received| {
            if last.elapsed() >= Duration::from_millis(200) {
                last = Instant::now();
                self.publish(app,json!({"state":"downloading","message":"更新をダウンロードしています","percent":(received as f64/candidate.size as f64*100.0).clamp(0.0,100.0),"info":{"version":candidate.version}}));
            }
        })?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if hash != expected {
            return Err("更新ファイルのSHA-256が一致しません".into());
        }
        validate_executable(&temporary)?;
        // An unknown existing file is preserved, rather than overwritten.
        if destination.exists() {
            return Err("更新先に別のファイルがあります。更新キャッシュを確認してください".into());
        }
        fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        guard.created = false;
        self.finish_download(&directory, &candidate, &expected, app)
    }
    fn finish_download(
        &self,
        directory: &Path,
        candidate: &Candidate,
        hash: &str,
        app: &AppHandle,
    ) -> Result<(), String> {
        let manifest = directory.join("pending.json");
        if let Ok(bytes) = manifest_bytes(&manifest) {
            if let Ok(previous) = serde_json::from_slice::<Staged>(&bytes) {
                if previous.candidate.filename != candidate.filename
                    && installer_version(&previous.candidate.filename).is_some()
                {
                    let previous_file = directory.join(&previous.candidate.filename);
                    if file_hash(&previous_file, previous.candidate.size)
                        .ok()
                        .as_deref()
                        == Some(previous.sha256.as_str())
                    {
                        let _ = fs::remove_file(previous_file);
                    }
                }
            }
        }
        let staged = Staged {
            candidate: candidate.clone(),
            sha256: hash.into(),
        };
        let temporary = directory.join("pending.rust.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&staged).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(&temporary, &manifest).map_err(|e| e.to_string())?;
        self.publish(app,json!({"state":"downloaded","message":"ダウンロードを確認しました。インストーラーを起動できます","percent":100,"info":{"version":candidate.version}}));
        Ok(())
    }
    fn install(&self, data: &Path, app: &AppHandle) -> Result<(), String> {
        let directory = data.join("updates");
        let bytes = manifest_bytes(&directory.join("pending.json"))
            .map_err(|_| "先に更新をダウンロードしてください")?;
        let staged: Staged = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let version = installer_version(&staged.candidate.filename)
            .ok_or("Invalid Tauri installer filename")?;
        if version.to_string() != staged.candidate.version
            || version
                <= semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?
            || !valid_hash(&staged.sha256)
        {
            return Err("Invalid staged update version".into());
        }
        let path = directory.join(&staged.candidate.filename);
        if file_hash(&path, staged.candidate.size)? != staged.sha256 {
            return Err("ダウンロード後に更新ファイルが変更されました".into());
        }
        validate_executable(&path)?;
        std::process::Command::new(path)
            .spawn()
            .map_err(|e| e.to_string())?;
        app.exit(0);
        Ok(())
    }
}
fn manifest_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 8192 {
        return Err("Invalid staged update metadata".into());
    }
    Ok(bytes)
}
struct Temporary {
    path: PathBuf,
    created: bool,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.created {
            let _ = fs::remove_file(&self.path);
        }
    }
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn installer_version(filename: &str) -> Option<semver::Version> {
    let version = filename
        .strip_prefix("TanukiBCL-Tauri-Beta-Setup-")?
        .strip_suffix(".exe")?;
    if version.len() > 128
        || version
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && !b".-+".contains(&b))
    {
        return None;
    }
    let version = semver::Version::parse(version).ok()?;
    version
        .pre
        .as_str()
        .starts_with("tauri-beta.")
        .then_some(version)
}
fn release_url(url: &str, filename: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .path()
            .starts_with(&format!("/{REPOSITORY}/releases/download/"))
        && url.path_segments().and_then(|s| s.last()) == Some(filename)
        && url.query().is_none()
        && url.fragment().is_none()
}
fn select(releases: &Value, current: &str) -> Result<Option<Candidate>, String> {
    let current = semver::Version::parse(current).map_err(|e| e.to_string())?;
    let rows = releases
        .as_array()
        .filter(|r| r.len() <= 100)
        .ok_or("Invalid release list")?;
    let mut selected = None;
    let mut newest = current;
    for release in rows {
        if release["draft"] == true {
            continue;
        }
        for asset in release["assets"].as_array().into_iter().flatten().take(256) {
            let Some(name) = asset["name"].as_str() else {
                continue;
            };
            let Some(version) = installer_version(name) else {
                continue;
            };
            if version <= newest {
                continue;
            }
            let Some(url) = asset["browser_download_url"]
                .as_str()
                .filter(|url| release_url(url, name))
            else {
                continue;
            };
            let Some(size) = asset["size"]
                .as_u64()
                .filter(|n| (1024..=LIMIT).contains(n))
            else {
                continue;
            };
            let digest = asset["digest"]
                .as_str()
                .and_then(|s| s.strip_prefix("sha256:"))
                .filter(|v| valid_hash(v))
                .map(str::to_ascii_lowercase);
            let checksum_name = format!("{name}.sha256");
            let checksum = release["assets"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|v| v["name"] == checksum_name)
                .and_then(|v| v["browser_download_url"].as_str())
                .filter(|url| release_url(url, &checksum_name))
                .map(str::to_owned);
            if digest.is_none() && checksum.is_none() {
                continue;
            }
            newest = version.clone();
            selected = Some(Candidate {
                version: version.to_string(),
                filename: name.into(),
                url: url.into(),
                size,
                sha256: digest,
                checksum,
            });
        }
    }
    Ok(selected)
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("TanukiBCL-Tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}
fn get(
    client: &reqwest::blocking::Client,
    address: &str,
) -> Result<reqwest::blocking::Response, String> {
    let mut address = tauri::Url::parse(address).map_err(|e| e.to_string())?;
    for _ in 0..6 {
        if address.scheme() != "https"
            || !matches!(
                address.host_str(),
                Some(
                    "github.com"
                        | "api.github.com"
                        | "objects.githubusercontent.com"
                        | "release-assets.githubusercontent.com"
                        | "github-releases.githubusercontent.com"
                )
            )
        {
            return Err("Unsupported update download host".into());
        }
        let response = client
            .get(address.clone())
            .send()
            .map_err(|e| e.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("Missing update redirect")?;
            address = address.join(location).map_err(|e| e.to_string())?;
            continue;
        }
        return response.error_for_status().map_err(|e| e.to_string());
    }
    Err("Too many update redirects".into())
}
fn stream(
    mut source: impl Read,
    destination: &mut impl Write,
    expected: u64,
    mut progress: impl FnMut(u64),
) -> Result<String, String> {
    if expected == 0 || expected > LIMIT {
        return Err("Update size exceeds limit".into());
    }
    let mut sha = Sha256::new();
    let mut bytes = [0u8; 65536];
    let mut total = 0u64;
    loop {
        let count = source.read(&mut bytes).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > expected {
            return Err("Update download exceeds declared size".into());
        }
        sha.update(&bytes[..count]);
        destination
            .write_all(&bytes[..count])
            .map_err(|e| e.to_string())?;
        progress(total);
    }
    if total != expected {
        return Err("Update download was truncated".into());
    }
    Ok(format!("{:x}", sha.finalize()))
}
fn file_hash(path: &Path, expected: u64) -> Result<String, String> {
    if expected > LIMIT || fs::metadata(path).map_err(|e| e.to_string())?.len() != expected {
        return Err("Invalid cached update size".into());
    }
    stream(
        File::open(path).map_err(|e| e.to_string())?,
        &mut std::io::sink(),
        expected,
        |_| {},
    )
}
fn validate_executable(path: &Path) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..2] != b"MZ" {
        return Err("Update is not a Windows executable".into());
    }
    let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
    if offset > 1024 * 1024 {
        return Err("Invalid installer PE header".into());
    }
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| e.to_string())?;
    let mut signature = [0u8; 4];
    file.read_exact(&mut signature).map_err(|e| e.to_string())?;
    if &signature != b"PE\0\0" {
        return Err("Invalid installer PE signature".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_newer_hashed_tauri_installers_from_the_release_repository_are_selected() {
        let name = "TanukiBCL-Tauri-Beta-Setup-3.2.62-tauri-beta.8.exe";
        let asset = json!({"name":name,"size":12345,"digest":format!("sha256:{}","a".repeat(64)),"browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/v3.2.62/{name}")});
        let release =
            json!([{"assets":[asset.clone(),{"name":"TanukiBCL-Setup-99.0.0.exe","size":12345}]}]);
        let candidate = select(&release, "3.2.62-tauri-beta.7").unwrap().unwrap();
        assert_eq!(candidate.version, "3.2.62-tauri-beta.8");
        assert!(select(&release, "3.2.62-tauri-beta.8").unwrap().is_none());
        let mut bad = asset;
        bad["browser_download_url"] = json!("https://example.invalid/installer.exe");
        assert!(select(&json!([{"assets":[bad]}]), "3.2.62-tauri-beta.7")
            .unwrap()
            .is_none());
        assert!(installer_version("../TanukiBCL.exe").is_none());
    }
    #[test]
    fn streaming_hash_rejects_truncated_or_oversized_updates_without_buffering_the_download() {
        let payload = vec![42u8; 200000];
        let mut output = Vec::new();
        let hash = stream(&payload[..], &mut output, payload.len() as u64, |_| {}).unwrap();
        assert_eq!(hash, format!("{:x}", Sha256::digest(&payload)));
        assert_eq!(output, payload);
        assert!(stream(&payload[..], &mut std::io::sink(), 199999, |_| {}).is_err());
        assert!(stream(&payload[..], &mut std::io::sink(), 200001, |_| {}).is_err());
    }
}
