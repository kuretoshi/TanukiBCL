//! Extra Unity texture codecs, including the Crunch format used by SNR packs.
use unity_bundle_assets::{Assets, Bundle, Image};
pub fn decode(assets: &Assets, bundle: &Bundle, id: i64) -> Result<Image, String> {
    let texture = assets.texture(id).map_err(|e| e.to_string())?;
    let (w, h) = (texture.width as usize, texture.height as usize);
    if w == 0 || h == 0 || w > 4096 || h > 4096 {
        return Err("Texture dimensions exceed limit".into());
    }
    let data = if !texture.image_data.is_empty() {
        texture.image_data
    } else {
        let stream = texture.stream.as_ref().ok_or("Missing texture pixels")?;
        let path = stream.path.replace('\\', "/");
        let leaf = path.rsplit('/').next().ok_or("Invalid texture stream")?;
        let entry = bundle
            .entry(&path)
            .or_else(|| {
                bundle
                    .entries()
                    .iter()
                    .find(|e| e.path().eq_ignore_ascii_case(leaf))
            })
            .ok_or("Missing bundled texture stream")?;
        let bytes = bundle.bytes(entry).ok_or("Missing texture stream")?;
        let start = usize::try_from(stream.offset).map_err(|_| "Texture offset overflow")?;
        let end = start
            .checked_add(stream.size as usize)
            .ok_or("Texture length overflow")?;
        bytes.get(start..end).ok_or("Truncated texture stream")?
    };
    if data.len() > 32 * 1024 * 1024 {
        return Err("Texture encoding exceeds limit".into());
    }
    let mut pixels = vec![0u32; w * h];
    use texture2ddecoder::*;
    let format = texture.format;
    if matches!(format, 28 | 29 | 64 | 65) {
        let mut info = CrnTextureInfo::default();
        if !info.crnd_get_texture_info(data, data.len() as u32)
            || info.width as usize != w
            || info.height as usize != h
            || info.faces != 1
            || info.levels > 16
        {
            return Err("Invalid Crunch dimensions".into());
        }
    }
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match format {
        24 => decode_bc6_unsigned(data, w, h, &mut pixels),
        28 | 29 | 64 | 65 => decode_unity_crunch(data, w, h, &mut pixels)
            .or_else(|_| decode_crunch(data, w, h, &mut pixels)),
        30 | 31 => decode_pvrtc_2bpp(data, w, h, &mut pixels),
        32 | 33 => decode_pvrtc_4bpp(data, w, h, &mut pixels),
        34 | 60 => decode_etc1(data, w, h, &mut pixels),
        35 => decode_atc_rgb4(data, w, h, &mut pixels),
        36 => decode_atc_rgba8(data, w, h, &mut pixels),
        41 => decode_eacr(data, w, h, &mut pixels),
        42 => decode_eacr_signed(data, w, h, &mut pixels),
        43 => decode_eacrg(data, w, h, &mut pixels),
        44 => decode_eacrg_signed(data, w, h, &mut pixels),
        45 => decode_etc2_rgb(data, w, h, &mut pixels),
        46 => decode_etc2_rgba1(data, w, h, &mut pixels),
        47 | 61 => decode_etc2_rgba8(data, w, h, &mut pixels),
        48..=59 | 66..=71 => {
            let base = if format >= 66 {
                66
            } else if format >= 54 {
                54
            } else {
                48
            };
            let side = [4, 5, 6, 8, 10, 12][(format - base) as usize];
            decode_astc(data, w, h, side, side, &mut pixels)
        }
        _ => Err("Unsupported extra Unity texture format"),
    }))
    .map_err(|_| "Invalid compressed texture")?
    .map_err(str::to_string);
    decoded?;
    let mut rgba = vec![0; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let b = pixels[y * w + x].to_le_bytes();
            let i = ((h - 1 - y) * w + x) * 4;
            rgba[i..i + 4].copy_from_slice(&[b[2], b[1], b[0], b[3]]);
        }
    }
    Image::new(w as u32, h as u32, rgba).map_err(|e| e.to_string())
}
