//! Bounded, in-memory WAV helpers for local recognition.
pub fn valid_wav(bytes: &[u8]) -> bool {
    if !(3244..=320044).contains(&bytes.len()) || bytes.len() % 2 != 0 {
        return false;
    }
    let u16_at = |p| u16::from_le_bytes(bytes[p..p + 2].try_into().unwrap());
    let u32_at = |p| u32::from_le_bytes(bytes[p..p + 4].try_into().unwrap());
    &bytes[..4] == b"RIFF"
        && u32_at(4) as usize == bytes.len() - 8
        && &bytes[8..16] == b"WAVEfmt "
        && u32_at(16) == 16
        && u16_at(20) == 1
        && u16_at(22) == 1
        && u32_at(24) == 16000
        && u32_at(28) == 32000
        && u16_at(32) == 2
        && u16_at(34) == 16
        && &bytes[36..40] == b"data"
        && u32_at(40) as usize == bytes.len() - 44
}
pub fn wav(pcm: &[i16]) -> Option<Vec<u8>> {
    if !(1600..=160000).contains(&pcm.len())
        || pcm
            .iter()
            .map(|v| (*v as f64 / 32768.).powi(2))
            .sum::<f64>()
            / (pcm.len() as f64)
            < 0.000001
    {
        return None;
    }
    let mut out = Vec::with_capacity(44 + pcm.len() * 2);
    out.extend(b"RIFF");
    out.extend((36 + pcm.len() as u32 * 2).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(16000u32.to_le_bytes());
    out.extend(32000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((pcm.len() as u32 * 2).to_le_bytes());
    for sample in pcm {
        out.extend(sample.to_le_bytes());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn bounded_wav() {
        let wav = super::wav(&vec![1000; 16000]).unwrap();
        assert!(super::valid_wav(&wav));
        assert!(super::wav(&vec![0; 16000]).is_none());
        assert!(super::wav(&vec![1000; 160001]).is_none());
    }
}
