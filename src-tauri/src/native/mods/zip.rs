//! Read only the ZIP directory and requested entry, rather than retaining an
//! entire addon archive in memory. No extraction into the game installation.
use super::memory::{slice, u32_at};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};
const IMAGE_LIMIT: usize = 16 * 1024 * 1024;
#[derive(Clone)]
pub struct Entry {
    pub archive: PathBuf,
    pub name: String,
    offset: u64,
    compressed: usize,
    size: usize,
    method: u16,
}
#[derive(Clone, PartialEq, Eq)]
struct Signature {
    length: u64,
    changed: Option<SystemTime>,
    created: Option<SystemTime>,
}
fn signature(path: &Path) -> std::io::Result<Signature> {
    let stat = fs::metadata(path)?;
    Ok(Signature {
        length: stat.len(),
        changed: stat.modified().ok(),
        created: stat.created().ok(),
    })
}
fn u16_at(b: &[u8], at: usize) -> Result<u16, String> {
    Ok(u16::from_le_bytes(slice(b, at, 2)?.try_into().unwrap()))
}
fn block(file: &mut fs::File, address: u64, length: usize) -> Result<Vec<u8>, String> {
    file.seek(SeekFrom::Start(address))
        .map_err(|e| e.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    Ok(bytes)
}
pub fn index(path: &Path) -> Result<Vec<Entry>, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if !(22..=512 * 1024 * 1024).contains(&size) {
        return Err("Unsupported addon ZIP size".into());
    }
    let tail_size = size.min(65557) as usize;
    let tail = block(&mut file, size - tail_size as u64, tail_size)?;
    let end = (0..=tail.len() - 22)
        .rev()
        .find(|i| tail[*i..*i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or("ZIP directory not found")?;
    if u16_at(&tail, end + 4)? != 0 || u16_at(&tail, end + 6)? != 0 {
        return Err("Multipart ZIP is unsupported".into());
    }
    let length = u32_at(&tail, end + 12)? as usize;
    let address = u32_at(&tail, end + 16)? as u64;
    if length > IMAGE_LIMIT || address + length as u64 > size {
        return Err("Invalid ZIP directory".into());
    }
    let directory = block(&mut file, address, length)?;
    let mut at = 0;
    let mut entries = Vec::new();
    while at < directory.len() {
        if u32_at(&directory, at)? != 0x0201_4b50 {
            return Err("Invalid ZIP directory entry".into());
        }
        let name_length = u16_at(&directory, at + 28)? as usize;
        let extra = u16_at(&directory, at + 30)? as usize;
        let comment = u16_at(&directory, at + 32)? as usize;
        let name = String::from_utf8_lossy(slice(&directory, at + 46, name_length)?).into_owned();
        if u16_at(&directory, at + 8)? & 1 == 0
            && !name.ends_with('/')
            && !name.split('/').any(|part| part == "..")
        {
            entries.push(Entry {
                archive: path.to_owned(),
                name,
                offset: u32_at(&directory, at + 42)? as u64,
                compressed: u32_at(&directory, at + 20)? as usize,
                size: u32_at(&directory, at + 24)? as usize,
                method: u16_at(&directory, at + 10)?,
            });
        }
        at = at
            .checked_add(46 + name_length + extra + comment)
            .filter(|n| *n <= directory.len())
            .ok_or("Truncated ZIP directory entry")?;
    }
    Ok(entries)
}
impl Entry {
    pub fn size(&self) -> usize {
        self.size
    }
    pub fn read(&self) -> Result<Vec<u8>, String> {
        if self.size > IMAGE_LIMIT
            || self.compressed > IMAGE_LIMIT
            || ![0, 8].contains(&self.method)
        {
            return Err("Unsupported ZIP image".into());
        }
        let mut file = fs::File::open(&self.archive).map_err(|e| e.to_string())?;
        let header = block(&mut file, self.offset, 30)?;
        if u32_at(&header, 0)? != 0x0403_4b50 {
            return Err("Invalid ZIP local header".into());
        }
        let at = self.offset + 30 + u16_at(&header, 26)? as u64 + u16_at(&header, 28)? as u64;
        let bytes = block(&mut file, at, self.compressed)?;
        let output = if self.method == 0 {
            bytes
        } else {
            let mut output = Vec::new();
            flate2::read::DeflateDecoder::new(bytes.as_slice())
                .take((IMAGE_LIMIT + 1) as u64)
                .read_to_end(&mut output)
                .map_err(|e| e.to_string())?;
            output
        };
        if output.len() != self.size {
            return Err("Invalid ZIP image size".into());
        }
        Ok(output)
    }
}
#[derive(Default)]
pub struct Addons {
    root: PathBuf,
    ids: BTreeMap<PathBuf, (Signature, Vec<String>)>,
}
fn metadata_id(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let start = text.find("\"Id\"")? + 4;
    let rest = text[start..]
        .trim_start()
        .strip_prefix(':')?
        .trim_start()
        .strip_prefix('"')?;
    let end = rest.find('"')?;
    let id = &rest[..end];
    (!id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)))
    .then(|| id.to_owned())
}
impl Addons {
    pub fn ids(&mut self, root: &Path) -> Vec<String> {
        let Ok(root) = fs::canonicalize(root) else {
            return Vec::new();
        };
        if self.root != root {
            self.root = root.clone();
            self.ids.clear();
        }
        let mut seen = std::collections::HashSet::new();
        let mut output = std::collections::BTreeSet::new();
        for path in fs::read_dir(root.join("Addons"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")))
            .take(1024)
        {
            let Ok(path) = fs::canonicalize(path) else {
                continue;
            };
            if !path.starts_with(&root) {
                continue;
            }
            seen.insert(path.clone());
            let Ok(current) = signature(&path) else {
                continue;
            };
            let cached = self
                .ids
                .get(&path)
                .filter(|(old, _)| *old == current)
                .map(|(_, ids)| ids.clone());
            let ids = if let Some(ids) = cached {
                ids
            } else {
                let ids = index(&path)
                    .map(|entries| {
                        entries
                            .into_iter()
                            .filter(|e| {
                                (e.name == "addon.meta" || e.name.ends_with("/addon.meta"))
                                    && e.size() <= 65536
                            })
                            .filter_map(|e| e.read().ok().and_then(|b| metadata_id(&b)))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if signature(&path).ok().as_ref() != Some(&current) {
                    self.ids.remove(&path);
                    continue;
                }
                self.ids.insert(path, (current, ids.clone()));
                ids
            };
            output.extend(ids);
        }
        self.ids.retain(|path, _| seen.contains(path));
        output.into_iter().collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addon_metadata_accepts_nos_non_json_boolean_literals() {
        assert_eq!(
            metadata_id(br#"{"Id":"tanuki.bcl.roles","Enabled":True}"#).as_deref(),
            Some("tanuki.bcl.roles")
        );
        assert!(metadata_id(br#"{"Id":"../outside"}"#).is_none());
    }
}
