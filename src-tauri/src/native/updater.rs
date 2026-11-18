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
    checked: Mutex<Option<(Instant, Result<Option<Candidate>, String>)>>,
    busy: AtomicBool,
}
impl Default for Updater {
    fn default() -> Self {
        Self {
            state: Mutex::new(json!({"state":"idle","message":"更新を確認できます"})),
            candidate: Mutex::new(None),
            checked: Mutex::new(None),
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
        let candidate = self.cached_check(|| {
            let client = client()?;
            find_candidate(
                env!("CARGO_PKG_VERSION"),
                |url| metadata(&client, url),
                |url| download_size(&client, url),
            )
        })?;
        *self.candidate.lock().unwrap() = candidate.clone();
        self.publish(app,if let Some(c)=candidate{json!({"state":"available","message":format!("Rust版 {} を利用できます",c.version),"info":{"version":c.version,"releaseName":c.filename}})}else{json!({"state":"not-available","message":"現在利用できる新しいRust版はありません"})});
        Ok(())
    }
    fn cached_check(
        &self,
        check: impl FnOnce() -> Result<Option<Candidate>, String>,
    ) -> Result<Option<Candidate>, String> {
        let mut cached = self.checked.lock().unwrap();
        if let Some((when, result)) = cached.as_ref() {
            let ttl = if result.is_ok() { 300 } else { 60 };
            if when.elapsed() < Duration::from_secs(ttl) {
                return result.clone();
            }
        }
        let result = check();
        *cached = Some((Instant::now(), result.clone()));
        result
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
fn find_candidate(
    current: &str,
    mut fetch: impl FnMut(&str) -> Result<String, String>,
    mut size: impl FnMut(&str) -> Result<u64, String>,
) -> Result<Option<Candidate>, String> {
    let api = format!("https://api.github.com/repos/{REPOSITORY}/releases?per_page=20");
    let result = fetch(&api).and_then(|body| {
        let releases = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        select(&releases, current)
    });
    match result {
        Ok(candidate) => Ok(candidate),
        Err(_) => website_candidate(current, &mut fetch, &mut size).map_err(|_| {
            "更新情報を取得できませんでした。しばらく待って再確認するか、GitHubのリリースページからTauri版をダウンロードしてください。".into()
        }),
    }
}
// GitHub's public Atom feed and asset pages remain available when the REST API
// quota is exhausted. Never read download links or hashes from release notes.
fn website_candidate(
    current: &str,
    fetch: &mut impl FnMut(&str) -> Result<String, String>,
    size: &mut impl FnMut(&str) -> Result<u64, String>,
) -> Result<Option<Candidate>, String> {
    let current = semver::Version::parse(current).map_err(|e| e.to_string())?;
    let feed = fetch(&format!("https://github.com/{REPOSITORY}/releases.atom"))?;
    if !feed.contains("<feed ") || !feed.contains("</feed>") {
        return Err("Invalid release feed".into());
    }
    let links = regex::Regex::new(&format!(
        r#"<link\b[^>]*\bhref="https://github.com/{REPOSITORY}/releases/tag/([^"<>&]+)""#
    ))
    .unwrap();
    let mut tags = Vec::new();
    for link in links.captures_iter(&feed) {
        let tag = link[1].to_owned();
        if !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    if tags.is_empty() || tags.len() > 20 {
        return Err("Invalid release feed entries".into());
    }
    let rows = regex::Regex::new(r"(?s)<li\b[^>]*>(.*?)</li>").unwrap();
    let anchors = regex::Regex::new(r#"<a\b[^>]*\bhref="([^"<>&]+)""#).unwrap();
    let digest = regex::Regex::new(r#"\bvalue="sha256:([a-fA-F0-9]{64})""#).unwrap();
    let base = tauri::Url::parse("https://github.com").unwrap();
    let mut newest = current.clone();
    let mut selected: Option<Candidate> = None;
    for tag in tags {
        // Stable release tags may contain later Tauri betas of the same base.
        if semver::Version::parse(tag.trim_start_matches('v')).is_ok_and(|version| {
            (version.major, version.minor, version.patch)
                < (current.major, current.minor, current.patch)
        }) {
            continue;
        }
        let html = fetch(&format!(
            "https://github.com/{REPOSITORY}/releases/expanded_assets/{tag}"
        ))?;
        if !html.contains("</ul>") {
            return Err("Invalid release assets page".into());
        }
        for row in rows.captures_iter(&html) {
            for link in anchors.captures_iter(&row[1]) {
                let Ok(url) = base.join(&link[1]) else {
                    continue;
                };
                let Some(name) = url.path_segments().and_then(|s| s.last()) else {
                    continue;
                };
                let Some(version) = installer_version(name) else {
                    continue;
                };
                if version <= newest || !release_url(url.as_str(), name) {
                    continue;
                }
                let hash = digest.captures(&row[1]).map(|v| v[1].to_ascii_lowercase());
                let checksum_name = format!("{name}.sha256");
                let checksum = anchors
                    .captures_iter(&html)
                    .filter_map(|v| base.join(&v[1]).ok())
                    .find(|v| release_url(v.as_str(), &checksum_name))
                    .map(|v| v.to_string());
                if hash.is_none() && checksum.is_none() {
                    continue;
                }
                newest = version.clone();
                selected = Some(Candidate {
                    version: version.to_string(),
                    filename: name.into(),
                    url: url.to_string(),
                    size: 0,
                    sha256: hash,
                    checksum,
                });
            }
        }
    }
    if let Some(candidate) = selected.as_mut() {
        candidate.size = size(&candidate.url)?;
        if !(1024..=LIMIT).contains(&candidate.size) {
            return Err("Invalid update download size".into());
        }
    }
    Ok(selected)
}
fn metadata(client: &reqwest::blocking::Client, address: &str) -> Result<String, String> {
    let mut bytes = Vec::new();
    request(
        client,
        reqwest::Method::GET,
        address,
        Duration::from_secs(20),
    )?
    .take(8 * 1024 * 1024 + 1)
    .read_to_end(&mut bytes)
    .map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Update release response exceeds limit".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
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
fn download_size(client: &reqwest::blocking::Client, address: &str) -> Result<u64, String> {
    // HEAD has an empty body. Read the header, which describes a subsequent GET.
    request(
        client,
        reqwest::Method::HEAD,
        address,
        Duration::from_secs(20),
    )?
    .headers()
    .get(reqwest::header::CONTENT_LENGTH)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|size| (1024..=LIMIT).contains(size))
    .ok_or_else(|| "Invalid update download size".into())
}
fn get(
    client: &reqwest::blocking::Client,
    address: &str,
) -> Result<reqwest::blocking::Response, String> {
    request(
        client,
        reqwest::Method::GET,
        address,
        Duration::from_secs(300),
    )
}
fn request(
    client: &reqwest::blocking::Client,
    method: reqwest::Method,
    address: &str,
    timeout: Duration,
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
            .request(method.clone(), address.clone())
            .timeout(timeout)
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
    fn feed(tags: &[&str]) -> String {
        format!("<feed xmlns=\"http://www.w3.org/2005/Atom\">{}</feed>", tags.iter()
            .map(|tag| format!("<entry><link href=\"https://github.com/{REPOSITORY}/releases/tag/{tag}\"/></entry>"))
            .collect::<String>())
    }
    fn asset_row(name: &str, host: &str, hash: Option<&str>) -> String {
        format!("<li><a href=\"https://{host}/{REPOSITORY}/releases/download/v3.2.66/{name}\">{name}</a>{}</li>",
            hash.map(|hash| format!("<clipboard-copy value=\"sha256:{hash}\"></clipboard-copy>")).unwrap_or_default())
    }
    #[test]
    fn rate_limited_api_uses_public_release_assets_and_exact_download_size() {
        let name = "TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.1.exe";
        let hash = "a".repeat(64);
        let mut requests = Vec::new();
        let candidate = find_candidate(
            "3.2.62-tauri-beta.9",
            |url| {
                requests.push(url.to_owned());
                if url.contains("api.github.com") {
                    return Err("403 rate limit exceeded".into());
                }
                if url.ends_with(".atom") {
                    return Ok(feed(&["v3.2.66", "v3.2.61"]));
                }
                assert!(url.ends_with("expanded_assets/v3.2.66"));
                Ok(format!(
                    "<ul>{}{}</ul>",
                    asset_row(
                        "TanukiBCL-Setup-99.0.0.exe",
                        "github.com",
                        Some(&"b".repeat(64))
                    ),
                    asset_row(name, "github.com", Some(&hash))
                ))
            },
            |url| {
                assert!(url.ends_with(name));
                Ok(59330669)
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(candidate.version, "3.2.66-tauri-beta.1");
        assert_eq!(candidate.sha256.as_deref(), Some(hash.as_str()));
        assert_eq!(candidate.size, 59330669);
    }
    #[test]
    fn website_rejects_foreign_unsigned_and_older_assets_without_borrowing_other_rows_hashes() {
        let name = "TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.1.exe";
        for rows in [
            asset_row(name, "example.com", Some(&"a".repeat(64))),
            format!(
                "{}{}",
                asset_row(name, "github.com", None),
                asset_row("other.exe", "github.com", Some(&"b".repeat(64)))
            ),
            asset_row(
                "TanukiBCL-Tauri-Beta-Setup-3.2.62-tauri-beta.8.exe",
                "github.com",
                Some(&"a".repeat(64)),
            ),
        ] {
            let result = find_candidate(
                "3.2.62-tauri-beta.9",
                |url| {
                    if url.contains("api.github.com") {
                        Err("429".into())
                    } else if url.ends_with(".atom") {
                        Ok(feed(&["v3.2.66"]))
                    } else {
                        Ok(format!("<ul>{rows}</ul>"))
                    }
                },
                |_| panic!("Invalid assets must not be requested"),
            )
            .unwrap();
            assert!(result.is_none());
        }
    }
    #[test]
    fn website_selects_highest_version_and_accepts_a_checksum_sidecar() {
        let name = "TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.2.exe";
        let candidate = find_candidate(
            "3.2.66-tauri-beta.1",
            |url| {
                if url.contains("api.github.com") {
                    Err("403".into())
                } else if url.ends_with(".atom") {
                    Ok(feed(&["v3.2.66"]))
                } else {
                    Ok(format!(
                        "<ul>{}{}{}</ul>",
                        asset_row(
                            "TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.10.exe",
                            "github.com",
                            Some(&"a".repeat(64))
                        ),
                        asset_row(name, "github.com", None),
                        asset_row(&format!("{name}.sha256"), "github.com", None)
                    ))
                }
            },
            |_| Ok(12345),
        )
        .unwrap()
        .unwrap();
        assert_eq!(candidate.version, "3.2.66-tauri-beta.10");
        // A sidecar remains sufficient when GitHub has no digest for an old asset.
        let candidate = find_candidate(
            "3.2.66-tauri-beta.1",
            |url| {
                if url.contains("api.github.com") {
                    Err("403".into())
                } else if url.ends_with(".atom") {
                    Ok(feed(&["v3.2.66"]))
                } else {
                    Ok(format!(
                        "<ul>{}{}</ul>",
                        asset_row(name, "github.com", None),
                        asset_row(&format!("{name}.sha256"), "github.com", None)
                    ))
                }
            },
            |_| Ok(12345),
        )
        .unwrap()
        .unwrap();
        assert!(candidate.sha256.is_none());
        assert!(candidate
            .checksum
            .unwrap()
            .ends_with(&format!("{name}.sha256")));
    }
    #[test]
    fn malformed_web_metadata_and_invalid_sizes_fail_instead_of_reporting_no_update() {
        for (body, size) in [
            ("unavailable".to_owned(), 12345),
            (
                format!(
                    "<ul>{}</ul>",
                    asset_row(
                        "TanukiBCL-Tauri-Beta-Setup-3.2.66-tauri-beta.1.exe",
                        "github.com",
                        Some(&"a".repeat(64))
                    )
                ),
                LIMIT + 1,
            ),
        ] {
            assert!(find_candidate(
                "3.2.62-tauri-beta.9",
                |url| {
                    if url.contains("api.github.com") {
                        Err("403".into())
                    } else if url.ends_with(".atom") {
                        Ok(feed(&["v3.2.66"]))
                    } else {
                        Ok(body.clone())
                    }
                },
                |_| Ok(size)
            )
            .is_err());
        }
    }
    #[test]
    fn successful_api_does_not_request_web_pages_and_repeated_checks_use_cache() {
        assert!(find_candidate(
            "3.2.66-tauri-beta.1",
            |url| {
                assert!(url.contains("api.github.com"));
                Ok("[]".into())
            },
            |_| panic!("No asset download expected")
        )
        .unwrap()
        .is_none());
        let updater = Updater::default();
        assert!(updater.cached_check(|| Ok(None)).unwrap().is_none());
        assert!(updater
            .cached_check(|| panic!("A repeated click must use the cache"))
            .unwrap()
            .is_none());
        *updater.checked.lock().unwrap() =
            Some((Instant::now() - Duration::from_secs(301), Ok(None)));
        assert!(updater.cached_check(|| Err("offline".into())).is_err());
        assert!(updater
            .cached_check(|| panic!("Errors must also back off"))
            .is_err());
    }
    #[test]
    #[ignore = "Reads public GitHub metadata; downloads no installer"]
    fn live_website_fallback_finds_the_published_tauri_installer() {
        let client = client().unwrap();
        let candidate = find_candidate(
            "3.2.62-tauri-beta.9",
            |url| {
                if url.contains("api.github.com") {
                    Err("Simulated 403 rate limit exceeded".into())
                } else {
                    metadata(&client, url)
                }
            },
            |url| download_size(&client, url),
        )
        .unwrap()
        .unwrap();
        assert!(
            semver::Version::parse(&candidate.version).unwrap()
                > semver::Version::parse("3.2.62-tauri-beta.9").unwrap()
        );
        assert!((1024..=LIMIT).contains(&candidate.size));
        assert!(candidate.sha256.is_some() || candidate.checksum.is_some());
        eprintln!(
            "Public fallback selected {} ({} bytes)",
            candidate.filename, candidate.size
        );
    }
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
