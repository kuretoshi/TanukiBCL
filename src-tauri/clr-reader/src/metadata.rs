//! Bounded ECMA-335 metadata reader. Reads names, type relationships and enum
//! constants; it never loads a managed assembly or executes its initializers.
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct TypeDef {
    pub token: u32,
    pub name: String,
    pub extends: u32,
    pub first_field: u32,
    pub end_field: u32,
}
#[derive(Clone, Debug)]
pub struct FieldDef {
    pub token: u32,
    pub name: String,
    pub flags: u16,
}
pub struct Metadata {
    pub class_sizes: BTreeMap<u32, u32>,
    pub scope_name: String,
    pub types: Vec<TypeDef>,
    pub fields: Vec<FieldDef>,
    pub constants: BTreeMap<u32, i64>,
    pub type_refs: BTreeMap<u32, String>,
    pub interfaces: Vec<(u32, u32)>,
}
struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}
impl<'a> Cursor<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self
            .pos
            .checked_add(length)
            .ok_or("Metadata offset overflow")?;
        let value = self.data.get(self.pos..end).ok_or("Truncated metadata")?;
        self.pos = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, String> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn index(&mut self, size: usize) -> Result<u32, String> {
        match size {
            2 => self.u16().map(u32::from),
            4 => self.u32(),
            _ => Err("Invalid metadata index width".into()),
        }
    }
    fn compressed(&mut self) -> Result<u32, String> {
        let first = self.u8()?;
        if first & 0x80 == 0 {
            Ok(first as u32)
        } else if first & 0xc0 == 0x80 {
            Ok(((first as u32 & 0x3f) << 8) | self.u8()? as u32)
        } else if first & 0xe0 == 0xc0 {
            Ok(((first as u32 & 0x1f) << 24)
                | ((self.u8()? as u32) << 16)
                | ((self.u8()? as u32) << 8)
                | self.u8()? as u32)
        } else {
            Err("Invalid compressed metadata integer".into())
        }
    }
}
struct Tables<'a> {
    data: &'a [u8],
    rows: [u32; 64],
    offsets: [usize; 64],
    sizes: [usize; 64],
    string: usize,
    guid: usize,
    blob: usize,
}
impl<'a> Tables<'a> {
    fn idx(&self, table: usize) -> usize {
        if self.rows[table] < 65536 {
            2
        } else {
            4
        }
    }
    fn coded(&self, bits: u32, tables: &[usize]) -> usize {
        if tables.iter().all(|&t| self.rows[t] < (1 << (16 - bits))) {
            2
        } else {
            4
        }
    }
    fn row(&self, table: usize, index: u32) -> Result<Cursor<'a>, String> {
        if index == 0 || index > self.rows[table] {
            return Err("Invalid metadata row".into());
        }
        let pos = self.offsets[table] + (index as usize - 1) * self.sizes[table];
        Ok(Cursor::new(
            self.data
                .get(pos..pos + self.sizes[table])
                .ok_or("Truncated metadata row")?,
        ))
    }
    fn row_size(&self, t: usize) -> Result<usize, String> {
        let (s, g, b) = (self.string, self.guid, self.blob);
        let tdor = self.coded(2, &[2, 1, 27]);
        let mdor = self.coded(1, &[6, 10]);
        let implementation = self.coded(2, &[38, 35, 39]);
        Ok(match t {
            0 => 2 + s + 3 * g,
            1 => self.coded(2, &[0, 26, 35, 1]) + 2 * s,
            2 => 4 + 2 * s + tdor + self.idx(4) + self.idx(6),
            3 => self.idx(4),
            4 => 2 + s + b,
            5 => self.idx(6),
            6 => 8 + s + b + self.idx(8),
            7 => self.idx(8),
            8 => 4 + s,
            9 => self.idx(2) + tdor,
            10 => self.coded(3, &[2, 1, 26, 6, 27]) + s + b,
            11 => 2 + self.coded(2, &[4, 8, 23]) + b,
            12 => {
                self.coded(
                    5,
                    &[
                        6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42,
                        44, 43,
                    ],
                ) + self.coded(3, &[6, 10])
                    + b
            }
            13 => self.coded(1, &[4, 8]) + b,
            14 => 2 + self.coded(2, &[2, 6, 32]) + b,
            15 => 6 + self.idx(2),
            16 => 4 + self.idx(4),
            17 => b,
            18 => self.idx(2) + self.idx(20),
            19 => self.idx(20),
            20 => 2 + s + tdor,
            21 => self.idx(2) + self.idx(23),
            22 => self.idx(23),
            23 => 2 + s + b,
            24 => 2 + self.idx(6) + self.coded(1, &[20, 23]),
            25 => self.idx(2) + 2 * mdor,
            26 => s,
            27 => b,
            28 => 2 + self.coded(1, &[4, 6]) + s + self.idx(26),
            29 => 4 + self.idx(4),
            30 => 8,
            31 => 4,
            32 => 16 + b + 2 * s,
            33 => 4,
            34 => 12,
            35 => 12 + 2 * b + 2 * s,
            36 => 4 + self.idx(35),
            37 => 12 + self.idx(35),
            38 => 4 + s + b,
            39 => 8 + 2 * s + implementation,
            40 => 8 + s + implementation,
            41 => 2 * self.idx(2),
            42 => 4 + self.coded(1, &[2, 6]) + s,
            43 => mdor + b,
            44 => self.idx(42) + tdor,
            _ if self.rows[t] == 0 => 0,
            _ => return Err(format!("Unsupported metadata table {t}")),
        })
    }
}
fn heap_string(heap: &[u8], index: u32) -> Result<String, String> {
    let value = heap
        .get(index as usize..)
        .ok_or("Invalid string heap index")?;
    let end = value
        .iter()
        .take(4097)
        .position(|&c| c == 0)
        .ok_or("Invalid metadata string")?;
    std::str::from_utf8(&value[..end])
        .map(str::to_owned)
        .map_err(|_| "Invalid metadata UTF8".into())
}
fn heap_blob(heap: &[u8], index: u32) -> Result<&[u8], String> {
    let mut c = Cursor::new(
        heap.get(index as usize..)
            .ok_or("Invalid blob heap index")?,
    );
    let len = c.compressed()? as usize;
    if len > 1024 * 1024 {
        return Err("Metadata blob exceeds limit".into());
    }
    c.take(len)
}
fn qualified(namespace: String, name: String) -> String {
    if namespace.is_empty() {
        name
    } else {
        format!("{namespace}.{name}")
    }
}
fn tdor(value: u32) -> Result<u32, String> {
    if value == 0 {
        return Ok(0);
    }
    Ok(match value & 3 {
        0 => 0x02000000,
        1 => 0x01000000,
        2 => 0x1b000000,
        _ => return Err("Invalid TypeDefOrRef".into()),
    } | (value >> 2))
}
impl Metadata {
    pub fn parse(data: &[u8]) -> Result<Self, String> {
        if data.len() > 32 * 1024 * 1024 {
            return Err("Metadata exceeds limit".into());
        }
        let mut c = Cursor::new(data);
        if c.u32()? != 0x424a5342 {
            return Err("Managed metadata signature missing".into());
        }
        c.take(8)?;
        let version_len = c.u32()? as usize;
        if version_len > 256 || version_len % 4 != 0 {
            return Err("Invalid metadata version".into());
        }
        c.take(version_len)?;
        c.u16()?;
        let count = c.u16()?;
        if count > 16 {
            return Err("Too many metadata streams".into());
        }
        let mut streams = BTreeMap::new();
        for _ in 0..count {
            let offset = c.u32()? as usize;
            let size = c.u32()? as usize;
            let start = c.pos;
            let mut name = Vec::new();
            loop {
                let b = c.u8()?;
                if b == 0 {
                    break;
                }
                name.push(b);
                if name.len() > 32 {
                    return Err("Metadata stream name too long".into());
                }
            }
            let consumed = c.pos - start;
            c.take((4 - consumed % 4) % 4)?;
            let name = String::from_utf8(name).map_err(|_| "Invalid metadata stream name")?;
            let end = offset.checked_add(size).ok_or("Stream size overflow")?;
            let value = data.get(offset..end).ok_or("Invalid stream range")?;
            if streams.insert(name, value).is_some() {
                return Err("Duplicate metadata stream".into());
            }
        }
        let table_data = *streams
            .get("#~")
            .or_else(|| streams.get("#-"))
            .ok_or("Metadata tables missing")?;
        let strings = *streams.get("#Strings").ok_or("Metadata strings missing")?;
        let blobs = *streams.get("#Blob").ok_or("Metadata blobs missing")?;
        let mut c = Cursor::new(table_data);
        c.take(6)?;
        let flags = c.u8()?;
        c.u8()?;
        let valid = c.u64()?;
        c.u64()?;
        let mut t = Tables {
            data: table_data,
            rows: [0; 64],
            offsets: [0; 64],
            sizes: [0; 64],
            string: if flags & 1 != 0 { 4 } else { 2 },
            guid: if flags & 2 != 0 { 4 } else { 2 },
            blob: if flags & 4 != 0 { 4 } else { 2 },
        };
        for i in 0..64 {
            if valid & (1u64 << i) != 0 {
                t.rows[i] = c.u32()?;
                if t.rows[i] > 1_000_000 {
                    return Err("Metadata row limit exceeded".into());
                }
            }
        }
        if flags & 0x40 != 0 {
            c.u32()?;
        }
        let mut offset = c.pos;
        for i in 0..64 {
            t.offsets[i] = offset;
            t.sizes[i] = t.row_size(i)?;
            offset = offset
                .checked_add(t.rows[i] as usize * t.sizes[i])
                .ok_or("Metadata tables overflow")?;
            if offset > table_data.len() {
                return Err("Truncated metadata tables".into());
            }
        }
        let mut fields = Vec::new();
        let scope_name = if t.rows[0] == 1 {
            let mut r = t.row(0, 1)?;
            r.u16()?;
            heap_string(strings, r.index(t.string)?)?
        } else {
            return Err("Exactly one metadata module required".into());
        };
        for rid in 1..=t.rows[4] {
            let mut r = t.row(4, rid)?;
            let flags = r.u16()?;
            let name = heap_string(strings, r.index(t.string)?)?;
            // Validate the signature heap reference without retaining an
            // unused allocation for every field in large framework modules.
            let _ = heap_blob(blobs, r.index(t.blob)?)?;
            fields.push(FieldDef {
                token: 0x04000000 | rid,
                name,
                flags,
            });
        }
        let mut types: Vec<TypeDef> = Vec::new();
        for rid in 1..=t.rows[2] {
            let mut r = t.row(2, rid)?;
            r.u32()?;
            let name = heap_string(strings, r.index(t.string)?)?;
            let namespace = heap_string(strings, r.index(t.string)?)?;
            let extends = tdor(r.index(t.coded(2, &[2, 1, 27]))?)?;
            let first_field = r.index(t.idx(4))?;
            if first_field == 0 || first_field > t.rows[4] + 1 {
                return Err("Invalid type field range".into());
            }
            if let Some(previous) = types.last_mut() {
                if previous.first_field > first_field {
                    return Err("Unsorted type fields".into());
                }
                previous.end_field = first_field;
            }
            types.push(TypeDef {
                token: 0x02000000 | rid,
                name: qualified(namespace, name),
                extends,
                first_field,
                end_field: t.rows[4] + 1,
            });
        }
        // Nested names are resolved recursively with a strict depth/cycle guard.
        let mut nested = BTreeMap::new();
        for rid in 1..=t.rows[41] {
            let mut r = t.row(41, rid)?;
            let child = r.index(t.idx(2))?;
            let parent = r.index(t.idx(2))?;
            if child == 0
                || child > t.rows[2]
                || parent == 0
                || parent > t.rows[2]
                || nested.insert(child, parent).is_some()
            {
                return Err("Invalid nested type".into());
            }
        }
        fn nested_name(
            rid: u32,
            types: &[TypeDef],
            nested: &BTreeMap<u32, u32>,
            depth: usize,
        ) -> Result<String, String> {
            if depth > 32 {
                return Err("Nested type cycle/depth limit".into());
            }
            let name = &types[rid as usize - 1].name;
            if let Some(&parent) = nested.get(&rid) {
                Ok(format!(
                    "{}+{}",
                    nested_name(parent, types, nested, depth + 1)?,
                    name
                ))
            } else {
                Ok(name.clone())
            }
        }
        let names: Result<Vec<_>, _> = (1..=t.rows[2])
            .map(|rid| nested_name(rid, &types, &nested, 0))
            .collect();
        for (ty, name) in types.iter_mut().zip(names?) {
            ty.name = name;
        }
        let mut type_refs = BTreeMap::new();
        for rid in 1..=t.rows[1] {
            let mut r = t.row(1, rid)?;
            r.index(t.coded(2, &[0, 26, 35, 1]))?;
            let name = heap_string(strings, r.index(t.string)?)?;
            let namespace = heap_string(strings, r.index(t.string)?)?;
            type_refs.insert(0x01000000 | rid, qualified(namespace, name));
        }
        let mut constants = BTreeMap::new();
        for rid in 1..=t.rows[11] {
            let mut r = t.row(11, rid)?;
            let kind = r.u16()?;
            let parent = r.index(t.coded(2, &[4, 8, 23]))?;
            let value = heap_blob(blobs, r.index(t.blob)?)?;
            if parent & 3 != 0 {
                continue;
            }
            let value = match (kind, value.len()) {
                (2, 1) | (5, 1) => Some(value[0] as i64),
                (4, 1) => Some(value[0] as i8 as i64),
                (3, 2) | (7, 2) => Some(u16::from_le_bytes(value.try_into().unwrap()) as i64),
                (6, 2) => Some(i16::from_le_bytes(value.try_into().unwrap()) as i64),
                (9, 4) => Some(u32::from_le_bytes(value.try_into().unwrap()) as i64),
                (8, 4) => Some(i32::from_le_bytes(value.try_into().unwrap()) as i64),
                (10, 8) => Some(i64::from_le_bytes(value.try_into().unwrap())),
                (11, 8) => i64::try_from(u64::from_le_bytes(value.try_into().unwrap())).ok(),
                _ => None,
            };
            if let Some(value) = value {
                constants.insert(0x04000000 | (parent >> 2), value);
            }
        }
        let mut interfaces = Vec::new();
        for rid in 1..=t.rows[9] {
            let mut r = t.row(9, rid)?;
            interfaces.push((
                0x02000000 | r.index(t.idx(2))?,
                tdor(r.index(t.coded(2, &[2, 1, 27]))?)?,
            ));
        }
        let mut class_sizes = BTreeMap::new();
        for rid in 1..=t.rows[15] {
            let mut r = t.row(15, rid)?;
            r.u16()?;
            let size = r.u32()?;
            let ty = r.index(t.idx(2))?;
            if ty == 0
                || ty > t.rows[2]
                || size > 1024 * 1024
                || class_sizes.insert(0x02000000 | ty, size).is_some()
            {
                return Err("Invalid class layout".into());
            }
        }
        Ok(Self {
            class_sizes,
            scope_name,
            types,
            fields,
            constants,
            type_refs,
            interfaces,
        })
    }
    pub fn field(&self, token: u32) -> Result<&FieldDef, String> {
        if token >> 24 != 4 {
            return Err("FieldDef token required".into());
        }
        self.fields
            .get((token & 0xffffff).wrapping_sub(1) as usize)
            .ok_or("Unknown metadata field".into())
    }
    pub fn type_def(&self, token: u32) -> Result<&TypeDef, String> {
        if token >> 24 != 2 {
            return Err("TypeDef token required".into());
        }
        self.types
            .get((token & 0xffffff).wrapping_sub(1) as usize)
            .ok_or("Unknown metadata type".into())
    }
    pub fn enum_values(&self, token: u32) -> Result<BTreeMap<i64, String>, String> {
        let ty = self.type_def(token)?;
        let mut values = BTreeMap::new();
        let parent = if ty.extends >> 24 == 1 {
            self.type_refs.get(&ty.extends).map(String::as_str)
        } else {
            self.type_def(ty.extends).ok().map(|t| t.name.as_str())
        };
        if parent != Some("System.Enum") {
            return Ok(values);
        }
        for field in &self.fields[ty.first_field as usize - 1..ty.end_field as usize - 1] {
            if field.flags & 0x40 == 0 {
                continue;
            }
            if let Some(&value) = self.constants.get(&field.token) {
                values.insert(value, field.name.clone());
            }
        }
        Ok(values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_metadata_is_rejected_without_panics() {
        for n in 0..512 {
            let input = vec![0xff; n];
            assert!(Metadata::parse(&input).is_err());
        }
        let mut input = vec![0u8; 512];
        input[..4].copy_from_slice(b"BSJB");
        input[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Metadata::parse(&input).is_err());
    }
    #[test]
    fn compressed_integers_enforce_width() {
        assert_eq!(Cursor::new(&[0x7f]).compressed().unwrap(), 127);
        assert_eq!(Cursor::new(&[0x80, 0x80]).compressed().unwrap(), 128);
        assert_eq!(
            Cursor::new(&[0xc0, 0x01, 0x00, 0x00]).compressed().unwrap(),
            65536
        );
        assert!(Cursor::new(&[0xe0, 0, 0, 0]).compressed().is_err());
        assert!(Cursor::new(&[0xc0]).compressed().is_err());
    }
}
