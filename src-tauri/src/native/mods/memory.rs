//! Bounded reads from managed layouts discovered by the existing CLR helper.
//! Layouts are validated before dereferencing and snapshots are checked again
//! after copying; no managed address is treated as permanent across a GC.
use serde_json::Value;
pub type Read<'a> = dyn Fn(u64, usize) -> Result<Vec<u8>, String> + 'a;
pub fn uint(value: &Value, maximum: u64) -> Result<u64, String> {
    value
        .as_u64()
        .filter(|v| *v <= maximum)
        .ok_or_else(|| "Invalid managed layout integer".into())
}
pub fn offset(value: &Value, width: usize, limit: usize) -> Result<usize, String> {
    let n = uint(value, limit as u64)? as usize;
    if n.checked_add(width).is_none_or(|v| v > limit) {
        return Err("Managed field exceeds its structure".into());
    }
    Ok(n)
}
pub fn optional(value: &Value, width: usize, limit: usize) -> Result<Option<usize>, String> {
    if value.is_null() {
        Ok(None)
    } else {
        offset(value, width, limit).map(Some)
    }
}
pub fn pointer_valid(address: u64, ps: usize) -> bool {
    address >= 0x10000
        && address <= 9_007_199_254_740_991
        && (ps == 8 || address <= 0xffff_fffc)
        && address % ps as u64 == 0
}
pub fn pointer_field(value: &Value, ps: usize) -> Result<u64, String> {
    let n = uint(value, 9_007_199_254_740_991)?;
    if !pointer_valid(n, ps) {
        return Err("Invalid managed pointer".into());
    }
    Ok(n)
}
pub fn pointer_size(layout: &Value, pid: u32) -> Result<usize, String> {
    if layout["pid"].as_u64() != Some(pid as u64) {
        return Err("Managed layout belongs to another process".into());
    }
    match layout["pointerSize"].as_u64() {
        Some(4) => Ok(4),
        Some(8) => Ok(8),
        _ => Err("Invalid managed pointer size".into()),
    }
}
pub fn slice(bytes: &[u8], offset: usize, width: usize) -> Result<&[u8], String> {
    bytes
        .get(offset..offset.checked_add(width).ok_or("Invalid field range")?)
        .ok_or_else(|| "Truncated managed field".into())
}
pub fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        slice(bytes, offset, 4)?.try_into().unwrap(),
    ))
}
pub fn i32_at(bytes: &[u8], offset: usize) -> Result<i32, String> {
    Ok(u32_at(bytes, offset)? as i32)
}
pub fn f32_at(bytes: &[u8], offset: usize) -> Result<f32, String> {
    let n = f32::from_le_bytes(slice(bytes, offset, 4)?.try_into().unwrap());
    if !n.is_finite() {
        return Err("Invalid managed float".into());
    }
    Ok(n)
}
pub fn ptr_at(bytes: &[u8], offset: usize, ps: usize) -> Result<u64, String> {
    if ps == 4 {
        Ok(u32_at(bytes, offset)? as u64)
    } else {
        Ok(u64::from_le_bytes(
            slice(bytes, offset, 8)?.try_into().unwrap(),
        ))
    }
}
pub fn ptr(read: &Read<'_>, address: u64, ps: usize) -> Result<u64, String> {
    ptr_at(&read(address, ps)?, 0, ps)
}
pub fn u32_read(read: &Read<'_>, address: u64) -> Result<u32, String> {
    u32_at(&read(address, 4)?, 0)
}
pub fn utf16(bytes: &[u8], offset: usize, length: usize) -> Result<String, String> {
    Ok(String::from_utf16_lossy(
        &slice(bytes, offset, length * 2)?
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect::<Vec<_>>(),
    ))
}
pub fn boolean(bytes: &[u8], offset: usize) -> Result<bool, String> {
    match slice(bytes, offset, 1)?[0] {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err("Invalid managed flag".into()),
    }
}
pub fn verify(read: &Read<'_>, address: u64, bytes: &[u8]) -> Result<(), String> {
    if read(address, bytes.len())? != bytes {
        return Err("Managed snapshot changed during read".into());
    }
    Ok(())
}
