//! Lazy local SNR folder/UnityFS cosmetics. Only one bounded bundle is held.
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use unity_bundle_assets::{Assets, Bundle, Image, Limits, Rect, SerializedFile};
const LIMITS: Limits = Limits::DEFAULT
    .with_max_file_size(128 * 1024 * 1024)
    .with_max_decompressed(128 * 1024 * 1024)
    .with_max_objects(100000)
    .with_max_texture_pixels(4096 * 4096)
    .with_max_total_work(4096 * 4096 * 16);

// SNR loads the Sprite with its original rect/pivot, not the atlas's trimmed PNG.
// Restore the transparent border before the existing avatar layout scales that canvas.
fn sprite_canvas(image: Image, rect: Rect, offset: [f32; 2]) -> Result<Image, String> {
    if ![rect.width, rect.height, offset[0], offset[1]]
        .iter()
        .all(|v| v.is_finite())
        || !(1.0..=4096.0).contains(&rect.width)
        || !(1.0..=4096.0).contains(&rect.height)
        || offset.iter().any(|v| v.abs() > 4096.0)
    {
        return Err("Invalid SNR sprite canvas".into());
    }
    let (width, height) = (rect.width.round() as usize, rect.height.round() as usize);
    let left = offset[0].round() as isize;
    let bottom = offset[1].round() as isize;
    // Fractional atlas rectangles round outwards during extraction. One edge pixel may
    // extend beyond the full rect (present in SNR's installed selfie_front sprite).
    if width * height * 4 > 16 * 1024 * 1024
        || left < 0
        || bottom < 0
        || left + image.width() as isize > width as isize + 1
        || bottom + image.height() as isize > height as isize + 1
    {
        return Err("SNR sprite placement exceeds canvas".into());
    }
    // Unity's offsets start at the bottom; decoded PNG rows start at the top.
    let top = height as isize - bottom - image.height() as isize;
    let mut pixels = vec![0; width * height * 4];
    for y in 0..image.height() as usize {
        let target_y = top + y as isize;
        if !(0..height as isize).contains(&target_y) {
            continue;
        }
        let from_x = (-left).max(0) as usize;
        let until_x = (width as isize - left).max(0).min(image.width() as isize) as usize;
        if from_x >= until_x {
            continue;
        }
        let from = (y * image.width() as usize + from_x) * 4;
        let to = (target_y as usize * width + (left + from_x as isize) as usize) * 4;
        let count = (until_x - from_x) * 4;
        pixels[to..to + count].copy_from_slice(&image.rgba()[from..from + count]);
    }
    Image::new(width as u32, height as u32, pixels).map_err(|e| e.to_string())
}
struct Index {
    revision: String,
    bundle: Arc<Bundle>,
    images: HashMap<String, Vec<String>>,
    adaptive: HashMap<String, bool>,
    scaled: HashMap<String, bool>,
    container: HashMap<String, (String, i64)>,
    used: Instant,
}
#[derive(Default)]
pub struct Snr {
    root: PathBuf,
    index: Option<Index>,
    cache: VecDeque<(String, Vec<u8>, bool, bool)>,
    bytes: usize,
    last_visor_scale: Option<(String, Option<bool>)>,
}
fn revision(path: &Path) -> Option<String> {
    let m = fs::metadata(path).ok()?;
    Some(format!(
        "{}:{}:{:?}",
        path.display(),
        m.len(),
        m.modified().ok()
    ))
}
fn plain(id: &str) -> String {
    let mut tag = false;
    id.chars()
        .filter(|c| {
            if *c == '<' {
                tag = true;
                false
            } else if *c == '>' {
                tag = false;
                false
            } else {
                !tag
            }
        })
        .collect()
}
fn safe_name(name: &str) -> String {
    name.replace("...", ".")
        .chars()
        .filter(|c| *c >= ' ' && !"<>:\"/\\|?*".contains(*c))
        .collect()
}
fn hat_adaptive(definition: &Value, part: &str) -> bool {
    // Match SNR CustomCosmeticsHatOptions.GetOption, including per-layer overrides.
    let layer = if part == "hat-back" { "back" } else { "front" };
    definition[format!("{layer}_adaptive")] == true
        || (definition["adaptive"] == true
            && (definition[layer] == true || (layer == "front" && definition[layer].is_null())))
}
fn visor_scaled(definition: &Value) -> bool {
    definition["IsSNR"] == true || definition["IsSNR"] == "true" || definition["isSNR"] == true
}
fn file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("SNR PNG exceeds limit".into());
    }
    Ok(bytes)
}
struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
    big: bool,
}
impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.at.checked_add(n)?;
        let bytes = self.bytes.get(self.at..end)?;
        self.at = end;
        Some(bytes)
    }
    fn u32(&mut self) -> Option<u32> {
        let big = self.big;
        let b = self.take(4)?.try_into().ok()?;
        Some(if big {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    }
    fn i64(&mut self) -> Option<i64> {
        let big = self.big;
        let b = self.take(8)?.try_into().ok()?;
        Some(if big {
            i64::from_be_bytes(b)
        } else {
            i64::from_le_bytes(b)
        })
    }
    fn string(&mut self, max: usize) -> Option<String> {
        let len = self.u32()? as usize;
        if len > max {
            return None;
        }
        let s = std::str::from_utf8(self.take(len)?).ok()?.to_string();
        self.at = (self.at + 3) & !3;
        Some(s)
    }
    fn ptr(&mut self) -> Option<i64> {
        if self.u32()? != 0 {
            return None;
        }
        self.i64()
    }
}
fn container(file: &SerializedFile) -> HashMap<String, i64> {
    let mut entries = HashMap::new();
    for object in file.objects().iter().filter(|o| o.class_id() == 142) {
        let Some(bytes) = file.bytes(object) else {
            continue;
        };
        let mut r = Cursor {
            bytes,
            at: 0,
            big: file.big_endian(),
        };
        let parsed = (|| {
            r.string(4096)?;
            let preload = r.u32()? as usize;
            if preload > r.bytes.len().saturating_sub(r.at) / 12 {
                return None;
            }
            r.take(preload.checked_mul(12)?)?;
            let count = r.u32()? as usize;
            if count > 100000 {
                return None;
            }
            for _ in 0..count {
                let path = r.string(4096)?;
                r.take(8)?;
                let id = r.ptr()?;
                entries.insert(path.to_ascii_lowercase(), id);
            }
            Some(())
        })();
        if parsed.is_none() {
            entries.clear();
        }
    }
    entries
}
fn load(path: &Path) -> Result<Index, String> {
    let bundle = Arc::new(Bundle::open_with(path, LIMITS).map_err(|e| e.to_string())?);
    let mut all = HashMap::new();
    let mut definitions = Vec::new();
    for entry in bundle.serialized_files() {
        let file = SerializedFile::parse_with(
            bundle.bytes(entry).ok_or("Missing bundle entry")?.to_vec(),
            LIMITS,
        )
        .map_err(|e| e.to_string())?;
        let map = container(&file);
        for (path, id) in &map {
            all.insert(path.clone(), (entry.path().to_string(), *id));
            if path.starts_with("assets/hats/") || path.starts_with("assets/visors/") {
                if path.ends_with("/package.json") && path.split('/').count() == 4 {
                    if let Some(object) = file.object(*id).filter(|o| o.class_id() == 49) {
                        let mut r = Cursor {
                            bytes: file.bytes(object).unwrap_or_default(),
                            at: 0,
                            big: file.big_endian(),
                        };
                        if r.string(4096).is_some() {
                            if let Some(text) = r.string(1024 * 1024) {
                                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                                    definitions.push((path.clone(), v));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    let mut images = HashMap::new();
    let mut adaptive = HashMap::new();
    let mut scaled = HashMap::new();
    for (path, v) in definitions {
        let Some(package) = v["package"]["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
        else {
            continue;
        };
        let prefix = path.trim_end_matches("/package.json");
        for hat in v["hats"].as_array().into_iter().flatten().take(10000) {
            if let Some(id) = hat["hat_id"].as_str() {
                for (part, file) in [
                    ("hat-front", "front"),
                    ("hat-back", "back"),
                    ("skin", "front"),
                ] {
                    let key = format!("{part}:Modded_{package}_{id}");
                    adaptive.insert(key.clone(), hat_adaptive(hat, part));
                    images.insert(
                        key,
                        vec![format!("{prefix}/{id}/{file}.png").to_ascii_lowercase()],
                    );
                }
            }
        }
        for visor in v
            .get("visors")
            .or_else(|| v.get("Visors"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .take(10000)
        {
            if let Some(id) = visor["visor_id"].as_str() {
                let key = format!("visor:Modded_{package}_{id}");
                adaptive.insert(key.clone(), visor["adaptive"] == true);
                scaled.insert(key.clone(), visor_scaled(visor));
                images.insert(
                    key,
                    vec![
                        format!("{prefix}/{id}/idle.png").to_ascii_lowercase(),
                        format!("{prefix}/{id}/front.png").to_ascii_lowercase(),
                    ],
                );
            }
        }
    }
    Ok(Index {
        revision: revision(path).ok_or("Bundle disappeared")?,
        bundle,
        images,
        adaptive,
        scaled,
        container: all,
        used: Instant::now(),
    })
}
impl Snr {
    pub fn update(&mut self, game: &Path) {
        let root =
            fs::canonicalize(game.join("SuperNewRolesNext/CustomCosmetics")).unwrap_or_default();
        if root != self.root {
            *self = Self {
                root,
                ..Default::default()
            };
        }
        if self
            .index
            .as_ref()
            .is_some_and(|b| b.used.elapsed() > Duration::from_secs(120))
        {
            self.index = None;
        }
    }
    fn inside(&self, path: &Path) -> Option<PathBuf> {
        let p = fs::canonicalize(path).ok()?;
        (p.starts_with(&self.root) && p != self.root && !self.root.as_os_str().is_empty())
            .then_some(p)
    }
    fn folder(&self, id: &str, part: &str) -> Option<PathBuf> {
        let suffixes: &[&str] = match part {
            "hat-front" => &["_front.png"],
            "hat-back" => &["_back.png"],
            "visor" => &["_idle.png", "_front.png"],
            _ => &["_front.png", "_idle.png"],
        };
        for entry in fs::read_dir(&self.root).ok()?.take(1024).flatten() {
            if !entry.file_type().ok()?.is_dir() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_string();
            if folder.to_ascii_lowercase().ends_with(".bundle") {
                continue;
            }
            if let Some(name) = id.strip_prefix(&format!("Modded_{folder}_")) {
                for suffix in suffixes {
                    let path = entry.path().join(safe_name(name) + suffix);
                    if let Some(path) = self.inside(&path).filter(|p| p.is_file()) {
                        return Some(path);
                    }
                }
            }
        }
        None
    }
    fn bundles(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.root) {
            for entry in entries.take(1024).flatten() {
                if !entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".bundle")
                {
                    continue;
                }
                if let Some(folder) = self.inside(&entry.path()) {
                    if let Ok(entries) = fs::read_dir(folder) {
                        for file in entries.take(1024).flatten() {
                            if file
                                .file_name()
                                .to_string_lossy()
                                .to_ascii_lowercase()
                                .ends_with(".bundle")
                            {
                                if let Some(path) =
                                    self.inside(&file.path()).filter(|p| p.is_file())
                                {
                                    let modified =
                                        fs::metadata(&path).ok().and_then(|m| m.modified().ok());
                                    files.push((modified, path));
                                }
                            }
                        }
                    }
                }
            }
        }
        files.sort_by(|a, b| b.0.cmp(&a.0));
        files.into_iter().take(1024).map(|(_, p)| p).collect()
    }
    fn bundled(&mut self, id: &str, part: &str) -> Result<(Vec<u8>, bool, bool), String> {
        let mut failure = None;
        for file in self.bundles() {
            let Some(rev) = revision(&file) else { continue };
            let cache_key = format!("{rev}:{part}:{id}");
            if let Some((_, bytes, adaptive, scaled)) =
                self.cache.iter().find(|(k, _, _, _)| *k == cache_key)
            {
                return Ok((bytes.clone(), *adaptive, *scaled));
            }
            if self.index.as_ref().is_none_or(|i| i.revision != rev) {
                self.index = match load(&file) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        failure = Some(e);
                        None
                    }
                };
            }
            let Some(index) = &mut self.index else {
                continue;
            };
            index.used = Instant::now();
            let adaptive = index
                .adaptive
                .get(&format!("{part}:{id}"))
                .copied()
                .unwrap_or(false);
            let scaled = index
                .scaled
                .get(&format!("{part}:{id}"))
                .copied()
                .unwrap_or(false);
            for path in index
                .images
                .get(&format!("{part}:{id}"))
                .into_iter()
                .flatten()
            {
                let Some((entry, path_id)) = index.container.get(path) else {
                    continue;
                };
                let Ok(assets) = Assets::from_bundle(index.bundle.clone(), entry) else {
                    continue;
                };
                let sprite = assets
                    .sprites(|_| true)
                    .sprites
                    .into_iter()
                    .find(|s| s.path_id == *path_id);
                let image = if let Some(sprite) = sprite {
                    super::sprite::extract(&assets, &index.bundle, &sprite).and_then(|image| {
                        let placement = assets.placement(&sprite).map_err(|e| e.to_string())?;
                        sprite_canvas(image, sprite.rect, placement.texture_rect_offset)
                    })
                } else {
                    assets
                        .decode_texture(*path_id)
                        .map_err(|e| e.to_string())
                        .or_else(|_| super::texture::decode(&assets, &index.bundle, *path_id))
                };
                let image = match image {
                    Ok(image) => Some(image),
                    Err(error) => {
                        failure = Some(error);
                        None
                    }
                };
                if let Some(image) = image.filter(|i| i.width() <= 4096 && i.height() <= 4096) {
                    let bytes =
                        super::cosmetics::encode(image.width(), image.height(), image.rgba())?;
                    if bytes.len() > 16 * 1024 * 1024 {
                        return Err("SNR PNG exceeds limit".into());
                    }
                    while self.bytes + bytes.len() > 16 * 1024 * 1024 || self.cache.len() >= 64 {
                        let Some((_, old, _, _)) = self.cache.pop_front() else {
                            break;
                        };
                        self.bytes -= old.len();
                    }
                    self.bytes += bytes.len();
                    self.cache
                        .push_back((cache_key, bytes.clone(), adaptive, scaled));
                    return Ok((bytes, adaptive, scaled));
                }
            }
        }
        Err(failure.unwrap_or_else(|| "SNR cosmetic is not installed".into()))
    }
    pub fn image(&mut self, id: &str, part: &str) -> Result<Vec<u8>, String> {
        self.image_with_metadata(id, part).map(|(bytes, _)| bytes)
    }
    // Query immediately after image_for_color while holding the same cosmetics lock.
    // Standalone PNGs have no authoritative metadata and retain catalog fallbacks.
    pub fn cached_visor_scale(&self, id: &str) -> Option<bool> {
        self.last_visor_scale
            .as_ref()
            .filter(|(key, _)| key == &plain(id))
            .and_then(|(_, scaled)| *scaled)
    }
    pub fn image_with_metadata(
        &mut self,
        id: &str,
        part: &str,
    ) -> Result<(Vec<u8>, Option<bool>), String> {
        if !matches!(part, "hat-front" | "hat-back" | "visor" | "skin")
            || !id.starts_with("Modded_")
            || id.len() > 1024
            || self.root.as_os_str().is_empty()
        {
            return Err("Invalid SNR cosmetic".into());
        }
        let id = plain(id);
        if let Some(path) = self.folder(&id, part) {
            self.last_visor_scale = Some((id.clone(), None));
            file_bytes(&path).map(|bytes| (bytes, None))
        } else {
            let (bytes, adaptive, scaled) = self.bundled(&id, part)?;
            self.last_visor_scale = Some((id, Some(part == "visor" && scaled)));
            Ok((bytes, Some(adaptive)))
        }
    }
    pub fn image_for_color(
        &mut self,
        id: &str,
        part: &str,
        palette: &[[String; 2]],
        color: usize,
        fallback_adaptive: bool,
    ) -> Result<Vec<u8>, String> {
        let (bytes, local_adaptive) = self.image_with_metadata(id, part)?;
        if local_adaptive.unwrap_or(fallback_adaptive) {
            let colors = palette.get(color).ok_or("Invalid SNR tint")?;
            super::super::assets::recolor(&bytes, &colors[0], &colors[1])
        } else {
            Ok(bytes)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn special_visor_scale_is_retained_with_cached_image_metadata() {
        assert!(visor_scaled(&serde_json::json!({"IsSNR":true})));
        assert!(visor_scaled(&serde_json::json!({"IsSNR":"true"})));
        assert!(visor_scaled(&serde_json::json!({"isSNR":true})));
        assert!(!visor_scaled(&serde_json::json!({"adaptive":true})));
        let mut snr = Snr::default();
        snr.last_visor_scale = Some(("Modded_pack_special".into(), Some(true)));
        assert_eq!(snr.cached_visor_scale("Modded_pack_special"), Some(true));
        assert_eq!(snr.cached_visor_scale("Modded_pack_plain"), None);
        assert_eq!(snr.cached_visor_scale("Modded_pack_missing"), None);
        snr.last_visor_scale = Some(("Modded_pack_special".into(), Some(false)));
        assert_eq!(snr.cached_visor_scale("Modded_pack_special"), Some(false));
    }
    #[test]
    fn local_hat_adaptive_flags_match_snr_layer_options() {
        let definition = serde_json::json!({"adaptive":true,"back":true});
        assert!(hat_adaptive(&definition, "hat-front"));
        assert!(hat_adaptive(&definition, "hat-back"));
        assert!(hat_adaptive(&definition, "skin"));
        assert!(!hat_adaptive(
            &serde_json::json!({"adaptive":true}),
            "hat-back"
        ));
        assert!(!hat_adaptive(
            &serde_json::json!({"adaptive":true,"front":false}),
            "hat-front"
        ));
        assert!(hat_adaptive(
            &serde_json::json!({"front_adaptive":true}),
            "hat-front"
        ));
        assert!(hat_adaptive(
            &serde_json::json!({"back_adaptive":true}),
            "hat-back"
        ));
        assert!(!hat_adaptive(
            &serde_json::json!({"adaptive":"true"}),
            "hat-front"
        ));
        assert!(!hat_adaptive(&serde_json::json!({}), "hat-front"));
    }
    #[test]
    fn packed_snr_sprite_restores_full_canvas_and_bottom_origin_offset() {
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 200, 100, 50, 255,
        ];
        let image = Image::new(2, 2, rgba.clone()).unwrap();
        let full = sprite_canvas(
            image,
            Rect {
                x: 0.,
                y: 0.,
                width: 8.,
                height: 6.,
            },
            [2., 1.],
        )
        .unwrap();
        assert_eq!((full.width(), full.height()), (8, 6));
        let mut expected = vec![0; 8 * 6 * 4];
        expected[(3 * 8 + 2) * 4..(3 * 8 + 4) * 4].copy_from_slice(&rgba[..8]);
        expected[(4 * 8 + 2) * 4..(4 * 8 + 4) * 4].copy_from_slice(&rgba[8..]);
        assert_eq!(full.rgba(), expected);
    }
    #[test]
    fn snr_canvas_rejects_corrupt_dimensions_and_offsets() {
        for (width, offset) in [
            (f32::NAN, 0.),
            (4097., 0.),
            (300., f32::INFINITY),
            (300., -2.),
            (300., 301.),
        ] {
            let image = Image::new(1, 1, vec![255; 4]).unwrap();
            assert!(sprite_canvas(
                image,
                Rect {
                    x: 0.,
                    y: 0.,
                    width,
                    height: 375.
                },
                [offset, 0.]
            )
            .is_err());
        }
        assert!(sprite_canvas(
            Image::new(1, 1, vec![0; 4]).unwrap(),
            Rect {
                x: 0.,
                y: 0.,
                width: 4096.,
                height: 4096.
            },
            [0., 0.]
        )
        .is_err());
    }
    #[test]
    fn untrimmed_snr_canvas_is_identical_and_fractional_offsets_round_to_pixels() {
        let rgba = vec![
            255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 200, 100, 50, 255,
        ];
        let image = || Image::new(2, 2, rgba.clone()).unwrap();
        let rect = Rect {
            x: 0.,
            y: 0.,
            width: 2.,
            height: 2.,
        };
        assert_eq!(sprite_canvas(image(), rect, [0., 0.]).unwrap().rgba(), rgba);
        let rect = Rect {
            width: 8.,
            height: 6.,
            ..rect
        };
        assert_eq!(
            sprite_canvas(image(), rect, [2.076, 1.076]).unwrap().rgba(),
            sprite_canvas(image(), rect, [2., 1.]).unwrap().rgba()
        );
    }
    #[test]
    fn folder_ids_remove_markup_and_unsafe_file_characters() {
        assert_eq!(plain("Modded_<b>pack</b>_hat"), "Modded_pack_hat");
        assert_eq!(safe_name("../x:hat"), "..xhat");
    }
    #[test]
    fn bounded_unity_strings_reject_truncated_and_oversized_input() {
        let mut r = Cursor {
            bytes: &[255, 255, 255, 127],
            at: 0,
            big: false,
        };
        assert!(r.string(4096).is_none());
    }
}
