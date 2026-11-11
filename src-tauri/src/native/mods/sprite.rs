//! Release-compatible rectangular sprite extraction (tightMesh defaults to false).
//! Crop/packing adapted from unity-asset-reader-texture (MIT, fatal10110;
//! AssetStudio: Perfare / RazTools / Razviar). Bicubic resize derived from
//! ImageSharp 2.1.3 (Apache-2.0, Six Labors), via that package's scalar port.
//! Modified to use bounded Rust buffers; see licenses/unity-sprite-*.
use unity_bundle_assets::{Assets, Bundle, Image, Rotation, Sprite};

pub fn extract(assets: &Assets, bundle: &Bundle, sprite: &Sprite) -> Result<Image, String> {
    let p = assets.placement(sprite).map_err(|e| e.to_string())?;
    if p.texture.file_id != 0 || p.alpha_texture.file_id != 0 {
        return Err("External sprite texture is not bundled in this file".into());
    }
    let decode = |id| {
        assets
            .decode_texture(id)
            .map_err(|e| e.to_string())
            .or_else(|_| super::texture::decode(assets, bundle, id))
    };
    let image = decode(p.texture.path_id)?;
    let (w, h, mut pixels) = image.into_parts();
    if !p.alpha_texture.is_null() {
        let alpha = decode(p.alpha_texture.path_id)?;
        if alpha.width() != w || alpha.height() != h {
            return Err("Sprite alpha size mismatch".into());
        }
        for (rgb, a) in pixels.chunks_exact_mut(4).zip(alpha.rgba().chunks_exact(4)) {
            rgb[3] = a[0];
        }
    }
    let image = Image::new(w, h, pixels).map_err(|e| e.to_string())?;
    let (sw, sh) = if p.downscale > 0.0 && p.downscale != 1.0 {
        (
            (w as f32 / p.downscale).trunc(),
            (h as f32 / p.downscale).trunc(),
        )
    } else {
        (w as f32, h as f32)
    };
    // Bound both dimensions and intermediate pass storage, even for corrupt multipliers.
    if !(sw >= 1.0 && sh >= 1.0 && sw <= 4096.0 && sh <= 4096.0) {
        return Err("Sprite atlas scale exceeds limit".into());
    }
    let r = p.texture_rect;
    let x = r.x.floor();
    let y = r.y.floor();
    let right = (r.x + r.width).ceil().min(sw);
    let top = (r.y + r.height).ceil().min(sh);
    if ![r.x, r.y, r.width, r.height].iter().all(|v| v.is_finite())
        || !(x >= 0.0 && y >= 0.0 && right > x && top > y)
    {
        return Err("Invalid sprite rectangle".into());
    }
    let (x, y, cw, ch) = (
        x as usize,
        y as usize,
        (right - x) as usize,
        (top - y) as usize,
    );
    let mut cropped = if sw as u32 == w && sh as u32 == h {
        let mut out = vec![0; cw * ch * 4];
        for row in 0..ch {
            let from = ((h as usize - 1 - y - row) * w as usize + x) * 4;
            out[row * cw * 4..(row + 1) * cw * 4]
                .copy_from_slice(&image.rgba()[from..from + cw * 4]);
        }
        out
    } else {
        resize_crop(&image, sw as usize, sh as usize, x, y, cw, ch)
    };
    let rotation = if p.settings.packed() {
        p.settings.rotation().ok_or("Invalid sprite rotation")?
    } else {
        Rotation::Unrotated
    };
    let turned = rotation == Rotation::Rotate90;
    let (ow, oh) = if turned { (ch, cw) } else { (cw, ch) };
    let mut out = vec![0; cropped.len()];
    for row in 0..oh {
        for col in 0..ow {
            let (sx, sy) = match rotation {
                Rotation::Unrotated => (col, row),
                Rotation::FlipHorizontal => (cw - 1 - col, row),
                Rotation::FlipVertical => (col, ch - 1 - row),
                Rotation::Rotate180 => (cw - 1 - col, ch - 1 - row),
                Rotation::Rotate90 => (cw - 1 - row, col),
                _ => return Err("Unsupported sprite rotation".into()),
            };
            let from = (sy * cw + sx) * 4;
            let to = ((oh - 1 - row) * ow + col) * 4;
            out[to..to + 4].copy_from_slice(&cropped[from..from + 4]);
        }
    }
    cropped.clear();
    Image::new(ow as u32, oh as u32, out).map_err(|e| e.to_string())
}

struct Kernel {
    start: usize,
    weights: Vec<f32>,
}
fn tolerant(value: f64, ceil: bool) -> f64 {
    let nearest = value.round_ties_even();
    if (value - nearest).abs() < 1e-8 {
        nearest
    } else if ceil {
        value.ceil()
    } else {
        value.floor()
    }
}
fn cubic(x: f32) -> f32 {
    let x = x.abs();
    if x <= 1.0 {
        ((1.5 * x - 2.5) * x) * x + 1.0
    } else if x < 2.0 {
        ((-0.5 * x + 2.5) * x - 4.0) * x + 2.0
    } else {
        0.0
    }
}
fn kernels(from: usize, to: usize, first: usize, count: usize) -> Vec<Kernel> {
    let ratio = from as f64 / to as f64;
    let scale = ratio.max(1.0);
    let radius = tolerant(scale * 2.0, true);
    (first..first + count)
        .map(|i| {
            let c = (i as f64 + 0.5) * ratio - 0.5;
            let start = tolerant(c - radius, true).max(0.0) as usize;
            let end = tolerant(c + radius, false).min(from as f64 - 1.0) as usize;
            let mut weights: Vec<_> = (start..=end)
                .map(|j| cubic(((j as f64 - c) / scale) as f32))
                .collect();
            let sum: f64 = weights.iter().map(|v| *v as f64).sum();
            if sum > 0.0 {
                for v in &mut weights {
                    *v = (*v as f64 / sum) as f32;
                }
            }
            Kernel { start, weights }
        })
        .collect()
}
fn byte(value: f32) -> u8 {
    (value * 255.0 + 0.5).clamp(0.0, 255.0) as u8
}
fn resize_crop(
    image: &Image,
    tw: usize,
    th: usize,
    x: usize,
    y: usize,
    w: usize,
    h: usize,
) -> Vec<u8> {
    let columns = kernels(image.width() as usize, tw, x, w);
    let rows = kernels(image.height() as usize, th, y, h);
    let first = rows.iter().map(|k| k.start).min().unwrap();
    let last = rows
        .iter()
        .map(|k| k.start + k.weights.len())
        .max()
        .unwrap();
    let stride = w * 4;
    let mut pass = vec![0.0f32; (last - first) * stride];
    let mut source = vec![0.0f32; image.width() as usize * 4];
    for row in first..last {
        let length = source.len();
        let from = (image.height() as usize - 1 - row) * length;
        for (to, p) in source
            .chunks_exact_mut(4)
            .zip(image.rgba()[from..from + length].chunks_exact(4))
        {
            let a = p[3] as f32 / 255.0;
            for c in 0..3 {
                to[c] = (p[c] as f32 / 255.0) * a;
            }
            to[3] = a;
        }
        for (col, k) in columns.iter().enumerate() {
            for c in 0..4 {
                let mut sum = 0.0;
                for (i, weight) in k.weights.iter().enumerate() {
                    sum += source[(k.start + i) * 4 + c] * weight;
                }
                pass[(row - first) * stride + col * 4 + c] = sum;
            }
        }
    }
    let mut out = vec![0; w * h * 4];
    for (row, k) in rows.iter().enumerate() {
        for col in 0..w {
            let mut sum = [0.0f32; 4];
            for (i, weight) in k.weights.iter().enumerate() {
                for c in 0..4 {
                    sum[c] += pass[(k.start - first + i) * stride + col * 4 + c] * weight;
                }
            }
            let at = (row * w + col) * 4;
            for c in 0..3 {
                out[at + c] = byte(sum[c] / sum[3]);
            }
            out[at + 3] = byte(sum[3]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn variant_atlas_pixels_match_release_scalar_resize() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../resources/tauri-sprite-resize-goldens.json"
        ))
        .unwrap();
        for c in cases.as_array().unwrap() {
            let n = |key: &str| c[key].as_u64().unwrap() as usize;
            let bytes = |key: &str| {
                c[key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap() as u8)
                    .collect::<Vec<_>>()
            };
            let image = Image::new(n("width") as u32, n("height") as u32, bytes("data")).unwrap();
            assert_eq!(
                resize_crop(
                    &image,
                    n("toWidth"),
                    n("toHeight"),
                    n("x"),
                    n("y"),
                    n("w"),
                    n("h")
                ),
                bytes("expected")
            );
        }
    }
}
