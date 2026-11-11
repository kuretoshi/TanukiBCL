mod helper;
pub(super) mod link;
mod live;
pub use live::Live;
pub(crate) mod addon;
pub(super) mod cosmetics;
mod memory;
mod nos;
mod push;
mod snr;
mod snr_cosmetics;
mod sprite;
mod texture;
mod toh;
mod zip;
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, path::Path};

/// Deterministic byte fixtures only; this mode never attaches to any process.
pub fn probe(input: &Path, output: &Path) -> Result<(), String> {
    let bytes = fs::read(input).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Mod fixture input too large".into());
    }
    let cases: Vec<Value> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if cases.len() > 128 {
        return Err("Too many mod fixtures".into());
    }
    let mut results = Vec::new();
    for case in cases {
        let mut regions = Vec::new();
        let mut total = 0;
        for row in case["regions"]
            .as_array()
            .filter(|a| a.len() <= 512)
            .ok_or("Invalid fixture regions")?
        {
            let address = memory::uint(&row["address"], 9_007_199_254_740_991)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(row["bytes"].as_str().ok_or("Invalid fixture bytes")?)
                .map_err(|e| e.to_string())?;
            total += bytes.len();
            if total > 2 * 1024 * 1024 {
                return Err("Fixture memory too large".into());
            }
            regions.push((address, bytes));
        }
        let reads = std::cell::Cell::new(0);
        let address_reads = std::cell::Cell::new(0);
        let read = |address: u64, length: usize| -> Result<Vec<u8>, String> {
            reads.set(reads.get() + 1);
            if length > 1024 * 1024 {
                return Err("Oversized fixture read".into());
            }
            for (base, bytes) in &regions {
                if let Some(start) = address
                    .checked_sub(*base)
                    .and_then(|n| usize::try_from(n).ok())
                {
                    if let Some(end) = start.checked_add(length).filter(|n| *n <= bytes.len()) {
                        let mut result = bytes[start..end].to_vec();
                        if case["mutateAddress"].as_u64() == Some(address) {
                            address_reads.set(address_reads.get() + 1);
                        }
                        if (case["changeOnRead"].as_u64() == Some(reads.get())
                            || (case["mutateAddress"].as_u64() == Some(address)
                                && case["afterReads"].as_u64() == Some(address_reads.get())))
                            && !result.is_empty()
                        {
                            result[0] ^= 1;
                        }
                        return Ok(result);
                    }
                }
            }
            Err("Unmapped fixture read".into())
        };
        let pid = memory::uint(&case["pid"], u32::MAX as u64)? as u32;
        let result = match case["mode"].as_str() {
            Some("nos") => nos::Layout::parse(&case["layout"], pid).and_then(|l| l.read(&read)),
            Some("palette") => nos::palette(&case["layout"], pid, &read),
            Some("snr") => snr::Layout::parse(&case["layout"], pid).and_then(|l| l.read(&read)),
            Some("meeting") => snr::Layout::parse(&case["layout"], pid)
                .map(|l| l.meeting(&read).unwrap_or(Value::Null)),
            Some("toh") => toh::Layout::parse(&case["layout"], pid).and_then(|l| l.read(&read)),
            _ => Err("Unsupported mod fixture mode".into()),
        };
        results.push(match result {
            Ok(value) => json!({"valid":true,"value":value,"reads":reads.get()}),
            Err(error) => json!({"valid":false,"error":error,"reads":reads.get()}),
        });
    }
    fs::write(
        output,
        serde_json::to_vec(&results).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}
