//! Local NoS sprite manifests and bounded PNG caches. Only assets registered by
//! the selected game can be requested; archives and images stay lazy.
use super::zip;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{BufReader, Cursor, Read},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
const DECODED_BUDGET: usize = 16 * 1024 * 1024;
pub fn probe(input: &Path, output: &Path) -> Result<(), String> {
    use base64::Engine;
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Cosmetic fixture too large".into());
    }
    let config: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let root = Path::new(config["root"].as_str().ok_or("Missing fixture root")?);
    let mut cosmetics = Cosmetics::default();
    cosmetics.update(root);
    cosmetics.snr.update(root);
    let mut results = Vec::new();
    for request in config["requests"]
        .as_array()
        .ok_or("Missing cosmetic fixtures")?
        .iter()
        .take(128)
    {
        let parts = cosmetics.player(
            &request["player"],
            request["lobby"] == true,
            &config["palette"],
        );
        let mut images = serde_json::Map::new();
        for (part, url) in parts.as_object().into_iter().flatten() {
            let image = (|| {
                let url = tauri::Url::parse(url.as_str().ok_or("Invalid sprite URL")?)
                    .map_err(|e| e.to_string())?;
                let color = url
                    .query_pairs()
                    .find(|(k, _)| k == "color")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                cosmetics.image(url.path().trim_start_matches('/'), &color)
            })();
            images.insert(
                part.clone(),
                image
                    .map(|b| json!(base64::engine::general_purpose::STANDARD.encode(b)))
                    .unwrap_or(Value::Null),
            );
        }
        if let (Some(id), Some(part)) = (request["snrId"].as_str(), request["snrPart"].as_str()) {
            match cosmetics.snr.image(id, part) {
                Ok(bytes) => {
                    images.insert(
                        "snr".into(),
                        json!(base64::engine::general_purpose::STANDARD.encode(bytes)),
                    );
                }
                Err(error) => {
                    images.insert("snr".into(), Value::Null);
                    images.insert("error".into(), json!(error));
                }
            }
        }
        results.push(json!({"images":images}));
    }
    fs::write(
        output,
        serde_json::to_vec(&json!({"status":cosmetics.status(),"results":results})).unwrap(),
    )
    .map_err(|e| e.to_string())
}
#[derive(Clone)]
enum Source {
    File(PathBuf),
    Zip(zip::Entry),
}
#[derive(Clone)]
struct Asset {
    source: Source,
    extra: Option<Source>,
    front: bool,
    columns: u32,
    rows: u32,
    adaptive: bool,
    mask: bool,
}
struct Bitmap {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}
pub struct Cosmetics {
    pub snr: super::snr_cosmetics::Snr,
    root: PathBuf,
    signature: String,
    checked: Instant,
    status: Value,
    assets: HashMap<String, Asset>,
    costumes: HashMap<String, HashMap<String, String>>,
    decoded: VecDeque<(String, Arc<Bitmap>)>,
    decoded_bytes: usize,
    images: VecDeque<(String, Vec<u8>)>,
    image_bytes: usize,
}
impl Default for Cosmetics {
    fn default() -> Self {
        Self {
            snr: super::snr_cosmetics::Snr::default(),
            root: PathBuf::new(),
            signature: String::new(),
            checked: Instant::now() - Duration::from_secs(3),
            status: Value::Null,
            assets: HashMap::new(),
            costumes: HashMap::new(),
            decoded: VecDeque::new(),
            decoded_bytes: 0,
            images: VecDeque::new(),
            image_bytes: 0,
        }
    }
}
fn signature(path: &Path) -> Result<String, String> {
    let m = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(format!(
        "{}:{}:{:?}:{:?}",
        path.to_string_lossy(),
        m.len(),
        m.modified().ok(),
        m.created().ok()
    ))
}
fn read_png(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take((16 * 1024 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("PNG exceeds the limit".into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<Bitmap, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("PNG exceeds the limit".into());
    }
    let mut decoder = png::Decoder::new(BufReader::new(Cursor::new(bytes)));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    if reader.info().width as u64 * reader.info().height as u64 > 16 * 1024 * 1024 {
        return Err("Decoded sprite exceeds the limit".into());
    }
    let size = reader
        .output_buffer_size()
        .filter(|s| *s <= 64 * 1024 * 1024)
        .ok_or("Decoded sprite exceeds the limit")?;
    let mut bytes = vec![0; size];
    let info = reader.next_frame(&mut bytes).map_err(|e| e.to_string())?;
    bytes.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => bytes,
        png::ColorType::Rgb => bytes
            .chunks_exact(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        png::ColorType::Grayscale => bytes.into_iter().flat_map(|p| [p, p, p, 255]).collect(),
        png::ColorType::GrayscaleAlpha => bytes
            .chunks_exact(2)
            .flat_map(|p| [p[0], p[0], p[0], p[1]])
            .collect(),
        _ => return Err("Unsupported PNG color type".into()),
    };
    Ok(Bitmap {
        width: info.width,
        height: info.height,
        rgba,
    })
}
pub(super) fn encode(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(rgba)
            .map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}
fn safe_file(root: &Path, base: &str, address: &str) -> Option<Source> {
    let file = fs::canonicalize(
        root.join(base.replace('\\', "/"))
            .join(address.replace('\\', "/")),
    )
    .ok()?;
    if !file.starts_with(root)
        || file == root
        || !file
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("png"))
        || fs::metadata(&file).ok()?.len() > 16 * 1024 * 1024
    {
        return None;
    }
    Some(Source::File(file))
}
fn zip_images(root: &Path) -> HashMap<String, Arc<HashMap<String, Source>>> {
    let mut output = HashMap::new();
    for file in fs::read_dir(root.join("Addons"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")))
        .take(1024)
    {
        let Ok(file) = fs::canonicalize(file) else {
            continue;
        };
        if !file.starts_with(root) {
            continue;
        }
        let Ok(entries) = zip::index(&file) else {
            continue;
        };
        for meta in entries
            .iter()
            .filter(|e| e.name.ends_with("MoreCosmic/Contents.json") && e.size() <= 4 * 1024 * 1024)
        {
            let Some(value) = meta.read().ok().and_then(|b| {
                serde_json::from_slice::<Value>(b.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&b))
                    .ok()
            }) else {
                continue;
            };
            let base = meta.name.strip_suffix("Contents.json").unwrap();
            for (kind, prefix) in [("hats", "noshat_"), ("visors", "nosvisor_")] {
                let directory = format!("{base}{kind}/");
                let images: HashMap<_, _> = entries
                    .iter()
                    .filter(|e| e.name.starts_with(&directory) && e.name.ends_with(".png"))
                    .map(|e| (e.name[directory.len()..].to_owned(), Source::Zip(e.clone())))
                    .collect();
                let images = Arc::new(images);
                for costume in value[kind].as_array().into_iter().flatten() {
                    if let (Some(author), Some(name)) =
                        (costume["Author"].as_str(), costume["Name"].as_str())
                    {
                        output.insert(format!("{prefix}{author}_{name}"), images.clone());
                    }
                }
            }
        }
    }
    output
}
impl Cosmetics {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn trim(&mut self) {
        self.decoded.clear();
        self.decoded_bytes = 0;
        self.images.clear();
        self.image_bytes = 0;
    }
    pub fn update(&mut self, game_root: &Path) {
        let Ok(root) = fs::canonicalize(game_root) else {
            self.clear();
            return;
        };
        if self.root == root && self.checked.elapsed() < Duration::from_secs(2) {
            return;
        }
        self.checked = Instant::now();
        let path = root.join("BepInEx/MoreCosmic/LoadedContents.json");
        let revision = signature(&path).unwrap_or_default();
        if self.root == root && self.signature == revision && !revision.is_empty() {
            return;
        }
        self.assets.clear();
        self.costumes.clear();
        self.trim();
        self.root = root;
        self.signature = revision.clone();
        let value = read_png(&path).and_then(|bytes| {
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("Manifest exceeds the limit".into());
            }
            serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes))
                .map_err(|e| e.to_string())
        });
        let value: Value = match value {
            Ok(v) => v,
            Err(error) => {
                self.status = json!({"path":path,"status":format!("読み取り失敗: {error}")});
                return;
            }
        };
        let supported = value["Version"] == 20261005;
        self.status = json!({"path":path,"status":if supported{"読み取り成功"}else{"画像表示は未対応の定義バージョンです"},"data":value});
        if !supported {
            return;
        }
        let mut archives = None;
        for (collection, kind) in [("Hats", "hat"), ("Visors", "visor"), ("Skins", "skin")] {
            for (id, costume) in value[collection].as_object().into_iter().flatten() {
                let Some(images) = costume["Images"].as_array() else {
                    continue;
                };
                let mut parts = HashMap::new();
                for (part, layer) in std::iter::once((kind, "Main"))
                    .chain((kind == "hat").then_some(("hatBack", "Back")))
                {
                    let Some(image) = images.iter().find(|i| i["Layer"] == layer) else {
                        continue;
                    };
                    let Some(address) = image["Address"].as_str() else {
                        continue;
                    };
                    let Some(columns) = image["DivisionX"]
                        .as_u64()
                        .filter(|n| (1..=256).contains(n))
                    else {
                        continue;
                    };
                    let Some(rows) = image["DivisionY"]
                        .as_u64()
                        .filter(|n| (1..=256).contains(n))
                    else {
                        continue;
                    };
                    let mut find = |address: &str| -> Option<Source> {
                        if let Some(base) = costume["RelatedRawLocalPath"].as_str() {
                            safe_file(&self.root, base, address)
                        } else {
                            if archives.is_none() {
                                archives = Some(zip_images(&self.root));
                            }
                            archives
                                .as_ref()?
                                .get(id)?
                                .get(&address.replace('\\', "/"))
                                .cloned()
                        }
                    };
                    let Some(source) = find(address) else {
                        continue;
                    };
                    let extra = image["ExAddress"].as_str().and_then(&mut find);
                    let mask = if kind == "hat" && layer == "Main" {
                        image["MaskAddress"].as_str().and_then(&mut find)
                    } else {
                        None
                    };
                    let key = format!(
                        "{:x}",
                        Sha256::digest(format!("{revision}:{kind}:{id}:{part}").as_bytes())
                    );
                    self.assets.insert(
                        key.clone(),
                        Asset {
                            source,
                            extra,
                            front: image["ExIsFront"] == true,
                            columns: columns as u32,
                            rows: rows as u32,
                            adaptive: costume["Adaptive"] == true,
                            mask: false,
                        },
                    );
                    parts.insert(part.to_owned(), key.clone());
                    if let Some(source) = mask {
                        let mask_key = format!("{key}mask");
                        self.assets.insert(
                            mask_key.clone(),
                            Asset {
                                source,
                                extra: None,
                                front: false,
                                columns: columns as u32,
                                rows: rows as u32,
                                adaptive: false,
                                mask: true,
                            },
                        );
                        parts.insert("bodyMask".into(), mask_key);
                    }
                }
                if !parts.is_empty() {
                    self.costumes.insert(format!("{kind}:{id}"), parts.clone());
                    if let Some(product) = costume["ProductId"].as_str() {
                        self.costumes.insert(format!("{kind}:{product}"), parts);
                    }
                }
            }
        }
    }
    pub fn status(&self) -> Value {
        self.status.clone()
    }
    pub fn player(&self, player: &Value, lobby: bool, palette: &Value) -> Value {
        if player["disconnected"] == true {
            return Value::Null;
        }
        let published = &player["nosPlayer"];
        let color = if lobby {
            let hex = player["nosLobbyColor"].as_str().or_else(|| {
                player["appearanceColorId"]
                    .as_u64()
                    .and_then(|id| palette[id as usize][0].as_str())
            });
            hex.and_then(|h| {
                if h.len() != 7
                    || !h.starts_with('#')
                    || !h.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                {
                    return None;
                }
                let rgb = [1, 3, 5].map(|at| {
                    u8::from_str_radix(&h[at..at + 2], 16)
                        .ok()
                        .map(|v| v as f64 / 255.0)
                });
                Some([rgb[0]?, rgb[1]?, rgb[2]?])
            })
            .unwrap_or([1.0; 3])
        } else {
            [
                published["colorR"].as_f64().unwrap_or(1.0),
                published["colorG"].as_f64().unwrap_or(1.0),
                published["colorB"].as_f64().unwrap_or(1.0),
            ]
        };
        let mut result = serde_json::Map::new();
        if !lobby && !published.is_object() {
            return Value::Null;
        }
        for (kind, appearance, original) in [
            ("skin", "appearanceSkinId", "skinId"),
            ("hat", "appearanceHatId", "hatId"),
            ("visor", "appearanceVisorId", "visorId"),
        ] {
            let name = if lobby {
                player[appearance]
                    .as_str()
                    .or_else(|| player[original].as_str())
            } else {
                published[kind]["name"].as_str()
            };
            if let Some(parts) = name.and_then(|n| self.costumes.get(&format!("{kind}:{n}"))) {
                for (part, key) in parts {
                    let tint = if self.assets.get(key).is_some_and(|a| a.adaptive) {
                        format!("{},{},{}", color[0], color[1], color[2])
                    } else {
                        "1,1,1".into()
                    };
                    result.insert(
                        part.clone(),
                        json!(format!(
                            "nos-cosmetic://image/{key}?color={}",
                            tint.replace(',', "%2C")
                        )),
                    );
                }
            }
        }
        if result.is_empty() {
            Value::Null
        } else {
            Value::Object(result)
        }
    }
    fn source(&mut self, source: &Source) -> Result<Arc<Bitmap>, String> {
        let path = match source {
            Source::File(p) => p,
            Source::Zip(e) => &e.archive,
        };
        let canonical = fs::canonicalize(path).map_err(|e| e.to_string())?;
        if !canonical.starts_with(&self.root) {
            return Err("Sprite is outside the selected game".into());
        }
        let key = format!(
            "{}:{}",
            signature(&canonical)?,
            match source {
                Source::File(_) => String::new(),
                Source::Zip(e) => e.name.clone(),
            }
        );
        if let Some(at) = self.decoded.iter().position(|(k, _)| *k == key) {
            let item = self.decoded.remove(at).unwrap();
            let result = item.1.clone();
            self.decoded.push_back(item);
            return Ok(result);
        }
        let bytes = match source {
            Source::File(_) => read_png(&canonical)?,
            Source::Zip(e) => e.read()?,
        };
        let bitmap = Arc::new(decode(&bytes)?);
        let size = bitmap.rgba.len();
        if size <= DECODED_BUDGET {
            while !self.decoded.is_empty()
                && (self.decoded.len() >= 32 || self.decoded_bytes + size > DECODED_BUDGET)
            {
                self.decoded_bytes -= self.decoded.pop_front().unwrap().1.rgba.len();
            }
            self.decoded_bytes += size;
            self.decoded.push_back((key, bitmap.clone()));
        }
        Ok(bitmap)
    }
    pub fn image(&mut self, key: &str, color: &str) -> Result<Vec<u8>, String> {
        let asset = self
            .assets
            .get(key)
            .cloned()
            .ok_or("Unregistered NoS image")?;
        let rgb: Vec<_> = color
            .split(',')
            .map(str::parse::<f64>)
            .collect::<Result<_, _>>()
            .map_err(|_| "Invalid NoS tint")?;
        if rgb.len() != 3
            || rgb
                .iter()
                .any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
        {
            return Err("Invalid NoS tint".into());
        }
        let cache_key = format!("{key}:{}", if asset.adaptive { color } else { "1,1,1" });
        if let Some(at) = self.images.iter().position(|(k, _)| *k == cache_key) {
            let item = self.images.remove(at).unwrap();
            let result = item.1.clone();
            self.images.push_back(item);
            return Ok(result);
        }
        let mut rgba = vec![if asset.mask { 255 } else { 0 }; 300 * 375 * 4];
        if !asset.front {
            if let Some(extra) = &asset.extra {
                let bitmap = self.source(extra)?;
                draw(&mut rgba, &bitmap, &asset, false, &rgb)?;
            }
        }
        let bitmap = self.source(&asset.source)?;
        draw(&mut rgba, &bitmap, &asset, asset.adaptive, &rgb)?;
        if asset.front {
            if let Some(extra) = &asset.extra {
                let bitmap = self.source(extra)?;
                draw(&mut rgba, &bitmap, &asset, false, &rgb)?;
            }
        }
        let image = encode(300, 375, &rgba)?;
        while !self.images.is_empty()
            && (self.images.len() >= 128 || self.image_bytes + image.len() > DECODED_BUDGET)
        {
            self.image_bytes -= self.images.pop_front().unwrap().1.len();
        }
        self.image_bytes += image.len();
        self.images.push_back((cache_key, image.clone()));
        Ok(image)
    }
}
fn draw(
    output: &mut [u8],
    source: &Bitmap,
    asset: &Asset,
    adaptive: bool,
    rgb: &[f64],
) -> Result<(), String> {
    if source.width % asset.columns != 0 || source.height % asset.rows != 0 {
        return Err("Invalid sprite divisions".into());
    }
    let width = source.width / asset.columns;
    let height = source.height / asset.rows;
    let left = (((300.0 - width as f64) * 0.53) + 0.5).floor() as i64;
    let top = (((375.0 - height as f64) * 0.425) + 0.5).floor() as i64;
    for y in 0..height as i64 {
        for x in 0..width as i64 {
            let dx = left + x;
            let dy = top + y;
            if !(0..300).contains(&dx) || !(0..375).contains(&dy) {
                continue;
            }
            let at = ((y * source.width as i64 + x) * 4) as usize;
            let target = ((dy * 300 + dx) * 4) as usize;
            let a = source.rgba[at + 3] as f64 / 255.0;
            let old = output[target + 3] as f64 / 255.0;
            let alpha = a + old * (1.0 - a);
            if alpha == 0.0 {
                continue;
            }
            if asset.mask {
                output[target + 3] = 255 - (source.rgba[at] as f64 * a).round() as u8;
                continue;
            }
            for ch in 0..3 {
                let pixel = if adaptive {
                    (source.rgba[at] as f64 * rgb[ch]
                        + source.rgba[at + 1] as f64 * [0.604, 0.792, 0.835][ch]
                        + source.rgba[at + 2] as f64 * rgb[ch] * 0.55)
                        .min(255.0)
                } else {
                    source.rgba[at + ch] as f64
                };
                output[target + ch] = ((pixel * a + output[target + ch] as f64 * old * (1.0 - a))
                    / alpha)
                    .round() as u8;
            }
            output[target + 3] = (alpha * 255.0).round() as u8;
        }
    }
    Ok(())
}
