use crate::state::{escaped as e, State};
use base64::Engine;
use serde_json::Value;
use std::{
    collections::VecDeque,
    io::Cursor,
    sync::{Mutex, OnceLock},
};
const CATALOG: &str = "https://cdn.jsdelivr.net/gh/OhMyGuus/BetterCrewLink-Hats@master/";
const PLAYER: &[u8] = include_bytes!("../../../static/images/generate/player.png");
const GHOST: &[u8] = include_bytes!("../../../static/images/generate/ghost.png");
fn uri(bytes: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
pub fn safe_url(raw: &str) -> String {
    let normalized = raw
        .replace("nos-cosmetic://", "https://nos-cosmetic.localhost/")
        .replace("snr-cosmetic://", "https://snr-cosmetic.localhost/")
        .replace("static://", "https://static.localhost/")
        .replace("generate://", "https://generate.localhost/");
    if normalized.starts_with("https://") || normalized.starts_with("data:image/png;base64,") {
        normalized
    } else {
        String::new()
    }
}
fn color(hex: &str) -> Option<[u8; 3]> {
    let value = hex.strip_prefix('#')?;
    if value.len() != 6 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some([
        u8::from_str_radix(&value[0..2], 16).ok()?,
        u8::from_str_radix(&value[2..4], 16).ok()?,
        u8::from_str_radix(&value[4..6], 16).ok()?,
    ])
}
pub fn nos_color(p: &Value) -> Option<String> {
    if let Some(hex) = p["nosLobbyColor"]
        .as_str()
        .filter(|hex| color(hex).is_some())
    {
        return Some(hex.into());
    }
    let n = &p["nosPlayer"];
    let channels: [f64; 3] = [
        n["colorR"].as_f64()?,
        n["colorG"].as_f64()?,
        n["colorB"].as_f64()?,
    ];
    if channels.iter().any(|n| !n.is_finite()) {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (channels[0].clamp(0.0, 1.0) * 255.0).round() as u8,
        (channels[1].clamp(0.0, 1.0) * 255.0).round() as u8,
        (channels[2].clamp(0.0, 1.0) * 255.0).round() as u8
    ))
}
fn tint(bytes: &[u8], body: [u8; 3]) -> Result<Vec<u8>, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .filter(|n| *n <= 4 * 1024 * 1024)
        .ok_or("Avatar template exceeds limit")?;
    let mut rgba = vec![0u8; size];
    let info = reader.next_frame(&mut rgba).map_err(|e| e.to_string())?;
    if info.color_type != png::ColorType::Rgba {
        return Err("RGBA avatar template required".into());
    }
    rgba.truncate(info.buffer_size());
    for pixel in rgba.chunks_exact_mut(4) {
        let (r, g, b) = (pixel[0] as f64, pixel[1] as f64, pixel[2] as f64);
        let max = r.max(g).max(b);
        let delta = max - r.min(g).min(b);
        if max == 0.0 || delta / max <= 0.4 {
            continue;
        }
        let mut hue = 60.0
            * if max == r {
                (g - b) / delta
            } else if max == g {
                2.0 + (b - r) / delta
            } else {
                4.0 + (r - g) / delta
            };
        if hue < 0.0 {
            hue += 360.0;
        }
        let near =
            |target: f64, distance: f64| 180.0 - ((hue - target).abs() - 180.0).abs() < distance;
        if !near(240.0, 30.0) && !near(0.0, 100.0) && !near(120.0, 40.0) {
            continue;
        }
        let green = if r > g && r > b {
            ((g - r * (16.0 / 255.0)) / (1.0 - 16.0 / 255.0)).max(0.0)
        } else {
            g
        };
        let blue = if r > g && r > b {
            ((b - r * (16.0 / 255.0)) / (1.0 - 16.0 / 255.0)).max(0.0)
        } else {
            b
        };
        for channel in 0..3 {
            let shadow = body[channel] as f64 * 0.6;
            let painted =
                shadow * (blue / 255.0) * (1.0 - r / 255.0) + body[channel] as f64 * (r / 255.0);
            pixel[channel] = (painted * (1.0 - green / 255.0)
                + [154.0, 202.0, 213.0][channel] * (green / 255.0))
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, info.width, info.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|e| e.to_string())?
            .write_image_data(&rgba)
            .map_err(|e| e.to_string())?;
    }
    Ok(output)
}
fn nos_body(alive: bool, hex: &str) -> Option<String> {
    type Cache = VecDeque<(String, String)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let key = format!("{alive}:{hex}");
    let cache = CACHE.get_or_init(|| Mutex::new(VecDeque::new()));
    {
        let mut cache = cache.lock().ok()?;
        if let Some(index) = cache.iter().position(|(k, _)| *k == key) {
            let item = cache.remove(index)?;
            let value = item.1.clone();
            cache.push_back(item);
            return Some(value);
        }
    }
    let bytes = tint(if alive { PLAYER } else { GHOST }, color(hex)?).ok()?;
    let value = uri(&bytes);
    if value.len() > 1024 * 1024 {
        return None;
    }
    let mut cache = cache.lock().ok()?;
    while cache.len() >= 64
        || cache.iter().map(|(_, v)| v.len()).sum::<usize>() + value.len() > 4 * 1024 * 1024
    {
        cache.pop_front()?;
    }
    cache.push_back((key, value.clone()));
    Some(value)
}
pub fn base(s: &State, p: &Value, alive: bool, color: i64) -> String {
    if s.effective_game()["mod"] == "NoS" {
        if let Some(rgb) = nos_color(p) {
            if let Some(body) = nos_body(alive, &rgb) {
                return body;
            }
        }
    }
    if color == -99234 {
        static ALIVE: OnceLock<String> = OnceLock::new();
        static DEAD: OnceLock<String> = OnceLock::new();
        return if alive {
            ALIVE
                .get_or_init(|| {
                    uri(include_bytes!(
                        "../../../static/images/avatar/rainbow-alive.png"
                    ))
                })
                .clone()
        } else {
            DEAD.get_or_init(|| {
                uri(include_bytes!(
                    "../../../static/images/avatar/rainbow-dead.png"
                ))
            })
            .clone()
        };
    }
    format!(
        "https://static.localhost/generated/{}/{}.png",
        if alive { "player" } else { "ghost" },
        color.clamp(0, 255)
    )
}
pub fn image(source: &str, class: &str, style: &str, scaling: bool) -> String {
    let source = safe_url(source);
    if source.is_empty() {
        return String::new();
    }
    format!(
        "<img class=\"{}\" src=\"{}\" style=\"{}\" {} alt=\"\">",
        e(class),
        e(&source),
        e(style),
        if scaling { "data-snr-scale=true" } else { "" }
    )
}
pub fn appearance_changed(player: &Value) -> bool {
    if !matches!(player["currentOutfit"].as_i64(), Some(1..=10)) {
        return false;
    }
    let normalized = |value: &Value| {
        let id = value.as_str().unwrap_or("");
        if ["hat_NoHat", "skin_None", "visor_EmptyVisor"].contains(&id) {
            "".to_owned()
        } else {
            id.to_owned()
        }
    };
    player["colorId"] != player["appearanceColorId"]
        || [
            ("hatId", "appearanceHatId"),
            ("skinId", "appearanceSkinId"),
            ("visorId", "appearanceVisorId"),
        ]
        .iter()
        .any(|(original, current)| normalized(&player[*original]) != normalized(&player[*current]))
}
fn plain(value: &str) -> String {
    let mut tag = false;
    value
        .chars()
        .filter(|&c| {
            if c == '<' {
                tag = true;
                return false;
            }
            if c == '>' {
                tag = false;
                return false;
            }
            !tag
        })
        .collect()
}
fn normalized(value: &str) -> String {
    let mut value = plain(value).to_lowercase();
    if value.ends_with(".png") {
        value.truncate(value.len() - 4);
    }
    while let Some((base, suffix)) = value.rsplit_once('_') {
        if ["front", "idle", "back", "flip", "adaptive", "bounce"].contains(&suffix) {
            value = base.to_owned();
        } else {
            break;
        }
    }
    value.chars().filter(char::is_ascii_alphanumeric).collect()
}
fn definition<'a>(id: &str, definitions: &'a Value) -> Option<&'a Value> {
    let list = definitions.as_array()?;
    let id = plain(id);
    list.iter()
        .find(|row| {
            id == format!(
                "Modded_{}_{}",
                row["package"].as_str().unwrap_or("NONE_PACKAGE"),
                row["name"].as_str().unwrap_or("")
            )
        })
        .or_else(|| {
            let id = normalized(&id);
            list.iter().find(|row| {
                let resource = normalized(row["resource"].as_str().unwrap_or(""));
                !resource.is_empty() && id.ends_with(&resource)
            })
        })
}
fn dimension(value: &Value, fallback: &str) -> String {
    let value = value.as_str().unwrap_or(fallback);
    if value.len() > 24 {
        return fallback.into();
    }
    let number = value
        .strip_suffix('%')
        .or_else(|| value.strip_suffix("px"))
        .unwrap_or(value);
    if number
        .parse::<f64>()
        .ok()
        .is_some_and(|n| n.is_finite() && n.abs() <= 2048.0)
    {
        value.into()
    } else {
        fallback.into()
    }
}
pub fn cosmetic(s: &State, id: &str, part: &str, color: i64, override_url: Option<&str>) -> String {
    if let Some(source) = override_url.filter(|u| !u.is_empty()) {
        return image(
            source,
            &format!("cosmetic {part}"),
            "top:-52%;width:140%;left:-18px",
            false,
        );
    }
    if id.is_empty() || ["hat_NoHat", "skin_None", "visor_EmptyVisor"].contains(&id) {
        return String::new();
    }
    let mode = s.effective_game()["mod"].as_str().unwrap_or("NONE");
    let collection = &s.catalog["collection"];
    let metadata = ["NONE", mode].iter().find_map(|&mode| {
        let data = &collection[mode];
        data["hats"]
            .get(id)
            .filter(|v| v.is_object())
            .map(|hat| (mode, data, hat))
    });
    if metadata.is_none() && mode == "SUPER_NEW_ROLES" && id.starts_with("Modded_") {
        let encoded = crate::state::encode(id);
        let definition = definition(
            id,
            &s.catalog[if part == "visor" {
                "snrVisors"
            } else {
                "snrHats"
            }],
        );
        let adaptive = definition.is_some_and(|d| {
            d["adaptive"] == true
                || d["resource"]
                    .as_str()
                    .is_some_and(|v| v.to_ascii_lowercase().contains("_adaptive"))
        }) || part.starts_with("hat")
            && plain(id).starts_with("Modded_Multiverse Costume SEL_");
        let query = if adaptive {
            format!("?adaptive=1&color={color}")
        } else {
            String::new()
        };
        let scaling = part == "visor"
            && definition
                .is_some_and(|d| d["IsSNR"] == true || d["IsSNR"] == "true" || d["isSNR"] == true);
        return image(
            &format!("https://snr-cosmetic.localhost/{part}/{encoded}{query}"),
            &format!("cosmetic {part}"),
            "top:-52%;width:140%;left:-18px",
            scaling,
        );
    }
    let Some((mode, data, hat)) = metadata else {
        return String::new();
    };
    let Some(file) = hat[if part == "hat-back" {
        "back_image"
    } else {
        "image"
    }]
    .as_str()
    .filter(|s| s.len() <= 2048) else {
        return String::new();
    };
    let source = format!("{CATALOG}{mode}/{file}");
    let source = if hat["multi_color"] == true {
        format!(
            "https://generate.localhost/hat?color={color}&url={}",
            crate::state::encode(&source)
        )
    } else {
        source
    };
    let top = dimension(
        if hat["top"].is_null() {
            &data["defaultTop"]
        } else {
            &hat["top"]
        },
        "0",
    );
    let left = dimension(
        if hat["left"].is_null() {
            &data["defaultLeft"]
        } else {
            &hat["left"]
        },
        "0",
    );
    let width = dimension(
        if hat["width"].is_null() {
            &data["defaultWidth"]
        } else {
            &hat["width"]
        },
        "0",
    );
    image(
        &source,
        &format!("cosmetic {part}"),
        &format!("top:{top};left:{left};width:{width}"),
        false,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn color_metadata_and_css_are_bounded() {
        assert_eq!(color("#12aBef"), Some([18, 171, 239]));
        assert!(color("red").is_none());
        assert_eq!(dimension(&serde_json::json!("2px;display:none"), "0"), "0");
        assert!(tint(PLAYER, [18, 171, 239]).unwrap().len() > 100);
    }
}
