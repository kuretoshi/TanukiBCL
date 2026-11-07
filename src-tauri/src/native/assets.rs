use super::http;
use reqwest::blocking::Client;
use std::{
    fs,
    io::{BufReader, Cursor},
    path::{Component, Path},
};

const LIMIT: usize = 8 * 1024 * 1024;
fn decode(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    if bytes.len() > LIMIT {
        return Err("Image exceeds the limit".into());
    }
    let mut decoder = png::Decoder::new(BufReader::new(Cursor::new(bytes)));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .filter(|s| *s <= 32 * 1024 * 1024)
        .ok_or("Decoded image exceeds the limit")?;
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
    Ok((info.width, info.height, rgba))
}
fn color(text: &str) -> Result<[f64; 3], String> {
    let hex = text.strip_prefix('#').ok_or("Invalid player color")?;
    if hex.len() != 6 {
        return Err("Invalid player color".into());
    }
    Ok([0, 2, 4]
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map(|v| v as f64))
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Invalid player color")?
        .try_into()
        .unwrap())
}
fn near(h: f64, target: f64, range: f64) -> bool {
    180.0 - ((h - target).abs() - 180.0).abs() < range
}
pub fn recolor(bytes: &[u8], body: &str, shadow: &str) -> Result<Vec<u8>, String> {
    let (width, height, mut rgba) = decode(bytes)?;
    let body = color(body)?;
    let shadow = color(shadow)?;
    let visor = [154.0, 202.0, 213.0];
    for pixel in rgba.chunks_exact_mut(4) {
        let r = pixel[0] as f64;
        let g = pixel[1] as f64;
        let b = pixel[2] as f64;
        let v = r.max(g).max(b);
        let c = v - r.min(g).min(b);
        let h = if c == 0.0 {
            0.0
        } else if v == r {
            (g - b) / c
        } else if v == g {
            2.0 + (b - r) / c
        } else {
            4.0 + (r - g) / c
        };
        let h = 60.0 * if h < 0.0 { h + 6.0 } else { h };
        if v != 0.0
            && c / v > 0.4
            && (near(h, 240.0, 30.0) || near(h, 0.0, 100.0) || near(h, 120.0, 40.0))
        {
            for i in 0..3 {
                // Preserve Color.mix's exact floating-point operation order;
                // direct interpolation differs by one channel value on a few
                // pixels after Uint8 truncation in the release implementation.
                let mix = |old: f64, new: f64, weight: f64| {
                    let first = ((2.0 * weight - 1.0) + 1.0) / 2.0;
                    first * new + (1.0 - first) * old
                };
                let value = mix(0.0, shadow[i], b / 255.0);
                let value = mix(value, body[i], r / 255.0);
                let value = mix(value, visor[i], g / 255.0);
                pixel[i] = value as u8;
            }
        }
    }
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(output)
}
pub fn generate(data: &Path, resources: &Path, colors: &[[String; 2]]) -> Result<(), String> {
    for name in ["player", "ghost"] {
        let directory = data.join("static/generated").join(name);
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let base = fs::read(resources.join("rust-assets").join(format!("{name}.png")))
            .map_err(|e| e.to_string())?;
        for (index, colors) in colors.iter().enumerate() {
            let bytes = recolor(&base, &colors[0], &colors[1])?;
            let path = directory.join(format!("{index}.png"));
            let temporary = path.with_extension("rust.tmp");
            fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
            fs::rename(temporary, path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
pub fn static_asset(data: &Path, raw: &str) -> Result<Vec<u8>, String> {
    let decoded = percent_encoding::percent_decode_str(raw.trim_start_matches('/'))
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    if decoded.contains('\\') || decoded.contains(':') {
        return Err("Invalid asset path".into());
    }
    let relative = Path::new(decoded.as_ref());
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || relative.extension().and_then(|e| e.to_str()) != Some("png")
    {
        return Err("Invalid asset path".into());
    }
    let root = data
        .join("static/generated")
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = data
        .join("static")
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("Invalid asset path".into());
    }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > LIMIT as u64 {
        return Err("Asset exceeds the limit".into());
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > LIMIT {
        return Err("Asset exceeds the limit".into());
    }
    Ok(bytes)
}
pub fn generated_hat(
    client: &Client,
    data: &Path,
    query: &str,
    colors: &[[String; 2]],
) -> Result<Vec<u8>, String> {
    let url = tauri::Url::parse(&format!("https://generate.localhost/hat?{query}"))
        .map_err(|e| e.to_string())?;
    let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
    let target = tauri::Url::parse(params.get("url").ok_or("Missing hat URL")?)
        .map_err(|e| e.to_string())?;
    if target.scheme() != "https"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.port().is_some()
        || !matches!(
            target.host_str(),
            Some("cdn.jsdelivr.net" | "raw.githubusercontent.com")
        )
    {
        return Err("Invalid hat collection".into());
    }
    if !(target.host_str() == Some("cdn.jsdelivr.net")
        && target
            .path()
            .starts_with("/gh/OhMyGuus/BetterCrewLink-Hats@master/"))
        && !(target.host_str() == Some("raw.githubusercontent.com")
            && target.path().starts_with("/OhMyGuus/BetterCrewLink-Hats/"))
    {
        return Err("Invalid hat collection".into());
    }
    let index = params
        .get("color")
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or("Invalid hat color")?;
    let colors = colors.get(index).ok_or("Unknown hat color")?;
    let key = super::reader::hash_code(&format!("{target}/{}/{}", colors[0], colors[1]));
    let path = data
        .join("static/generated/hats")
        .join(format!("{key}.png"));
    if let Ok(metadata) = path.metadata() {
        if metadata
            .modified()
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() < 300)
        {
            return fs::read(path).map_err(|e| e.to_string());
        }
    }
    let original = http::get(client, target.as_str(), LIMIT)?;
    let bytes = recolor(&original, &colors[0], &colors[1])?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(path, &bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rgba_conversion_preserves_alpha_and_white_highlights() {
        let mut original = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut original, 2, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&[255, 0, 0, 31, 255, 255, 255, 77])
                .unwrap();
        }
        let (_, _, bytes) = decode(&recolor(&original, "#117f2d", "#0a4d2e").unwrap()).unwrap();
        assert_eq!(bytes, [17, 127, 45, 31, 255, 255, 255, 77]);
    }
}
