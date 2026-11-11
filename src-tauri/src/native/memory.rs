//! Read-only process access. No allocation, code injection or writes in Among Us.
use std::{path::PathBuf, time::Instant};
use windows_sys::Win32::{
    Foundation::*,
    System::{
        Diagnostics::{Debug::ReadProcessMemory, ToolHelp::*},
        Threading::*,
    },
};

pub struct Handle(HANDLE);
// A process handle may be used from the reader thread; ownership stays unique.
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|c| *c == 0).unwrap_or(value.len())])
}
fn snapshot(flags: u32, pid: u32) -> Result<Handle, String> {
    let handle = unsafe { CreateToolhelp32Snapshot(flags, pid) };
    if handle == INVALID_HANDLE_VALUE {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(Handle(handle))
    }
}

pub fn find_process(name: &str, target: u32, index: usize) -> Result<Option<u32>, String> {
    let snapshot = snapshot(TH32CS_SNAPPROCESS, 0)?;
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of_val(&entry) as u32;
    let mut found = unsafe { Process32FirstW(snapshot.0, &mut entry) };
    let mut matches = Vec::new();
    while found != 0 {
        if entry.cntThreads > 0
            && wide(&entry.szExeFile).eq_ignore_ascii_case(name)
            && (target == 0 || target == entry.th32ProcessID)
        {
            matches.push(entry.th32ProcessID);
        }
        found = unsafe { Process32NextW(snapshot.0, &mut entry) };
    }
    matches.sort_unstable();
    Ok(matches.get(index).copied())
}

pub struct Process {
    handle: Handle,
    pub pid: u32,
    pub base: u64,
    pub size: usize,
    pub path: PathBuf,
    pub x64: bool,
}

impl Process {
    pub fn open(pid: u32) -> Result<Self, String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if handle.is_null() {
            return Err(format!(
                "ゲームを読み取れません: {}",
                std::io::Error::last_os_error()
            ));
        }
        let handle = Handle(handle);
        let snapshot = snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)?;
        let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = unsafe { Module32FirstW(snapshot.0, &mut entry) };
        let mut module = None;
        while found != 0 {
            if wide(&entry.szModule).eq_ignore_ascii_case("GameAssembly.dll") {
                module = Some((
                    entry.modBaseAddr as u64,
                    entry.modBaseSize as usize,
                    PathBuf::from(wide(&entry.szExePath)),
                ));
                break;
            }
            found = unsafe { Module32NextW(snapshot.0, &mut entry) };
        }
        let (base, size, path) = module.ok_or("GameAssembly.dll の読み込みを待っています")?;
        let mut process = Self {
            handle,
            pid,
            base,
            size,
            path,
            x64: true,
        };
        let header = process.u32(base + 0x3c)? as u64;
        process.x64 = process.bytes(base + header + 0x18, 2)? == [0x0b, 0x02];
        Ok(process)
    }
    pub fn alive(&self) -> bool {
        let mut code = 0;
        unsafe { GetExitCodeProcess(self.handle.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
    }
    pub fn modules(&self) -> Result<Vec<(String, PathBuf)>, String> {
        let snapshot = snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, self.pid)?;
        let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut found = unsafe { Module32FirstW(snapshot.0, &mut entry) };
        let mut modules = Vec::new();
        while found != 0 && modules.len() < 4096 {
            if entry.th32ProcessID == self.pid && entry.modBaseSize > 0 {
                modules.push((wide(&entry.szModule), PathBuf::from(wide(&entry.szExePath))));
            }
            found = unsafe { Module32NextW(snapshot.0, &mut entry) };
        }
        Ok(modules)
    }
    pub fn bytes(&self, address: u64, length: usize) -> Result<Vec<u8>, String> {
        if length > 256 * 1024 * 1024 || address < 0x10000 {
            return Err("Invalid game read".into());
        }
        let mut bytes = vec![0; length];
        let mut read = 0;
        if unsafe {
            ReadProcessMemory(
                self.handle.0,
                address as *const _,
                bytes.as_mut_ptr() as *mut _,
                length,
                &mut read,
            )
        } == 0
            || read != length
        {
            return Err("ゲームメモリの読み取りに失敗しました".into());
        }
        Ok(bytes)
    }
    pub fn u32(&self, address: u64) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.bytes(address, 4)?.try_into().unwrap(),
        ))
    }
    pub fn i32(&self, address: u64) -> Result<i32, String> {
        Ok(self.u32(address)? as i32)
    }
    pub fn pointer(&self, address: u64) -> Result<u64, String> {
        if !self.x64 {
            return self.u32(address).map(u64::from);
        }
        Ok(u64::from_le_bytes(
            self.bytes(address, 8)?.try_into().unwrap(),
        ))
    }
    pub fn address(&self, base: u64, offsets: &[i64]) -> Result<u64, String> {
        if base == 0 {
            return Ok(0);
        }
        let mut address = base;
        for (index, offset) in offsets.iter().enumerate() {
            address = address
                .checked_add_signed(*offset)
                .ok_or("Invalid pointer offset")?;
            if index + 1 != offsets.len() {
                address = self.pointer(address)?;
                if address == 0 {
                    return Ok(0);
                }
            }
        }
        Ok(address)
    }
    pub fn ptr_at(&self, base: u64, offsets: &[i64]) -> Result<u64, String> {
        let address = self.address(base, offsets)?;
        if address == 0 {
            Ok(0)
        } else {
            self.pointer(address)
        }
    }
    pub fn int_at(&self, base: u64, offsets: &[i64]) -> Result<i32, String> {
        let address = self.address(base, offsets)?;
        if address == 0 {
            Ok(0)
        } else {
            self.i32(address)
        }
    }
    pub fn byte_at(&self, base: u64, offsets: &[i64]) -> Result<u8, String> {
        let address = self.address(base, offsets)?;
        if address == 0 {
            Ok(0)
        } else {
            Ok(self.bytes(address, 1)?[0])
        }
    }
    pub fn float_at(&self, base: u64, offsets: &[i64]) -> Result<f64, String> {
        let address = self.address(base, offsets)?;
        let value = f32::from_le_bytes(self.bytes(address, 4)?.try_into().unwrap()) as f64;
        if value.is_finite() {
            Ok((value * 10000.0).round() / 10000.0)
        } else {
            Err("Invalid player position".into())
        }
    }
    pub fn string(&self, pointer: u64, limit: usize) -> String {
        (|| {
            if pointer == 0 {
                return Ok(String::new());
            }
            let count = self.i32(pointer + if self.x64 { 0x10 } else { 8 })?;
            if count < 0 || count > 4096 {
                return Err("Invalid IL2CPP string".to_string());
            }
            let bytes = self.bytes(
                pointer + if self.x64 { 0x14 } else { 12 },
                (count as usize).min(limit) * 2,
            )?;
            let units: Vec<_> = bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .filter(|c| *c != 0)
                .collect();
            Ok(String::from_utf16_lossy(&units))
        })()
        .unwrap_or_default()
    }
    pub fn dictionary(&self, address: u64, limit: usize) -> Result<Vec<(i32, u64)>, String> {
        if address == 0 {
            return Ok(Vec::new());
        }
        let entries = self.pointer(address + if self.x64 { 0x18 } else { 12 })?;
        let length = self.u32(address + if self.x64 { 0x20 } else { 16 })? as usize;
        if entries == 0 {
            return Ok(Vec::new());
        }
        (0..length.min(limit))
            .map(|index| {
                let entry = entries
                    + if self.x64 { 0x20 } else { 16 }
                    + index as u64 * if self.x64 { 0x18 } else { 16 };
                // For the integer/enum keys used by these IL2CPP dictionaries the
                // hash slot equals the key, as in the release GameReader.
                Ok((
                    self.i32(entry)?,
                    self.pointer(entry + if self.x64 { 0x10 } else { 12 })?,
                ))
            })
            .collect()
    }
    pub fn executable_sections(&self) -> Result<Vec<(u64, Vec<u8>)>, String> {
        let started = Instant::now();
        let pe = self.base + self.u32(self.base + 0x3c)? as u64;
        let header = self.bytes(pe, 24)?;
        if &header[..4] != b"PE\0\0" {
            return Err("Invalid PE header".into());
        }
        let count = u16::from_le_bytes([header[6], header[7]]) as usize;
        let optional = u16::from_le_bytes([header[20], header[21]]) as u64;
        if count > 96 {
            return Err("Invalid PE section count".into());
        }
        let sections = self.bytes(pe + 24 + optional, count * 40)?;
        let mut result = Vec::new();
        let mut total = 0;
        for section in sections.chunks_exact(40) {
            let number = |index| u32::from_le_bytes(section[index..index + 4].try_into().unwrap());
            if number(36) & 0x20000000 == 0 {
                continue;
            }
            let size = number(8) as usize;
            let relative = number(12) as u64;
            total += size;
            if total > 256 * 1024 * 1024 || relative + size as u64 > self.size as u64 {
                return Err("Executable sections exceed the scan limit".into());
            }
            let mut bytes = vec![0; size];
            for (index, chunk) in bytes.chunks_mut(65536).enumerate() {
                if started.elapsed().as_secs() > 20 {
                    return Err("Game signature scan timed out".into());
                }
                let mut read = 0;
                unsafe {
                    ReadProcessMemory(
                        self.handle.0,
                        (self.base + relative + index as u64 * 65536) as *const _,
                        chunk.as_mut_ptr() as *mut _,
                        chunk.len(),
                        &mut read,
                    );
                }
            }
            result.push((relative, bytes));
        }
        Ok(result)
    }
}

pub fn parse_pattern(text: &str) -> Result<Vec<Option<u8>>, String> {
    text.split_whitespace()
        .map(|part| {
            if part == "?" || part == "??" {
                Ok(None)
            } else {
                u8::from_str_radix(part, 16)
                    .map(Some)
                    .map_err(|_| "Invalid game signature".into())
            }
        })
        .collect()
}
pub fn find_pattern(bytes: &[u8], pattern: &[Option<u8>]) -> Option<usize> {
    let anchor = pattern.iter().position(Option::is_some)?;
    if pattern.len() > bytes.len() {
        return None;
    }
    let value = pattern[anchor].unwrap();
    bytes
        .iter()
        .enumerate()
        .filter(|(_, b)| **b == value)
        .find_map(|(index, _)| {
            let start = index.checked_sub(anchor)?;
            let sample = bytes.get(start..start.checked_add(pattern.len())?)?;
            pattern
                .iter()
                .zip(sample)
                .all(|(p, b)| p.is_none_or(|p| p == *b))
                .then_some(start)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signatures_handle_wildcards_and_bounds() {
        let pattern = parse_pattern("? 8B ? 01").unwrap();
        assert_eq!(find_pattern(&[0, 0x8b, 7, 1], &pattern), Some(0));
        assert_eq!(find_pattern(&[0, 0x8b, 7], &pattern), None);
        assert_eq!(find_pattern(&[0x8b, 7, 1], &pattern), None);
        assert!(parse_pattern("ZZ").is_err());
    }
}
