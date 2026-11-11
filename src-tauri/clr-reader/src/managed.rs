use crate::{
    abi::*,
    metadata::Metadata,
    runtime::{Field, Module, Runtime},
};
use serde::Serialize;
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Debug, Clone)]
pub struct NamedField {
    pub name: String,
    pub data: FieldData,
}
#[derive(Debug, Clone, Serialize)]
pub struct NumericField {
    pub offset: u64,
    pub size: usize,
    pub signed: bool,
    #[serde(serialize_with = "optional_names")]
    pub names: BTreeMap<i64, String>,
}
fn optional_names<S: serde::Serializer>(
    names: &BTreeMap<i64, String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if names.is_empty() {
        serializer.serialize_none()
    } else {
        names.serialize(serializer)
    }
}
pub struct Managed<'a> {
    pub runtime: &'a Runtime,
    metadata: RefCell<BTreeMap<u64, Metadata>>,
    fields: RefCell<BTreeMap<u64, Vec<NamedField>>>,
    types: RefCell<BTreeMap<u64, Vec<(u32, u64)>>>,
}
pub struct Dictionary {
    pub object: u64,
    pub object_type: u64,
    pub entries: u64,
    pub data: ObjectData,
    pub version: i64,
    pub count: i64,
    pub rows: Vec<u64>,
}
impl<'a> Managed<'a> {
    pub fn new(runtime: &'a Runtime) -> Self {
        Self {
            runtime,
            metadata: RefCell::new(BTreeMap::new()),
            fields: RefCell::new(BTreeMap::new()),
            types: RefCell::new(BTreeMap::new()),
        }
    }
    pub fn modules(&self) -> Result<Vec<Module>, String> {
        let mut modules = self.runtime.modules()?;
        for module in &mut modules {
            if module.name.is_empty() && module.data.metadata_size > 0 {
                module.name = self.metadata(module.address, |m| Ok(m.scope_name.clone()))?;
            }
        }
        Ok(modules)
    }
    pub fn metadata<T>(
        &self,
        module: u64,
        f: impl FnOnce(&Metadata) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.metadata.borrow().contains_key(&module) {
            let data = self.runtime.module_data(module)?;
            if data.metadata_size == 0 || data.metadata_size > 32 * 1024 * 1024 {
                return Err("Invalid module metadata size".into());
            }
            let bytes = self
                .runtime
                .target()
                .read(data.metadata, data.metadata_size as usize)?;
            let metadata = Metadata::parse(&bytes)?;
            self.metadata.borrow_mut().insert(module, metadata);
        }
        f(self.metadata.borrow().get(&module).unwrap())
    }
    pub fn fields(&self, ty: u64) -> Result<Vec<NamedField>, String> {
        if let Some(fields) = self.fields.borrow().get(&ty) {
            return Ok(fields.clone());
        }
        let fields: Result<Vec<_>, String> = self
            .runtime
            .fields(ty)?
            .into_iter()
            .map(|Field { data, .. }| {
                let owner = self.runtime.type_data(data.owner)?;
                let name =
                    self.metadata(owner.module, |m| Ok(m.field(data.token)?.name.clone()))?;
                Ok(NamedField { name, data })
            })
            .collect();
        let fields = fields?;
        self.fields.borrow_mut().insert(ty, fields.clone());
        Ok(fields)
    }
    pub fn field(&self, ty: u64, name: &str) -> Result<NamedField, String> {
        let backing = format!("<{name}>k__BackingField");
        self.fields(ty)?
            .into_iter()
            .find(|f| f.name == name || f.name == backing)
            .ok_or_else(|| {
                format!(
                    "Field {name} not found in {}",
                    self.runtime.type_name(ty).unwrap_or_default()
                )
            })
    }
    pub fn type_by_name(&self, module: u64, name: &str) -> Result<Option<u64>, String> {
        let token = self.metadata(module, |meta| {
            let mut matches = meta.types.iter().filter(|ty| ty.name == name);
            let token = matches.next().map(|ty| ty.token);
            if matches.next().is_some() {
                return Err(format!("Ambiguous type {name}"));
            }
            Ok(token)
        })?;
        if !self.types.borrow().contains_key(&module) {
            self.types
                .borrow_mut()
                .insert(module, self.runtime.type_map(module)?);
        }
        let Some(token) = token else {
            // Only instantiated generic names need the slower formatted name
            // lookup. Known Mod types resolve directly by metadata token.
            if name.contains('[') {
                return Ok(self
                    .runtime
                    .types(module)?
                    .into_iter()
                    .find(|ty| ty.name == name)
                    .map(|ty| ty.address));
            }
            return Ok(None);
        };
        let mut found = None;
        for &(rid, address) in self.types.borrow().get(&module).unwrap() {
            if rid == token & 0xffffff {
                let data = self.runtime.type_data(address)?;
                if data.module != module || data.token != token {
                    return Err("Type metadata identity changed".into());
                }
                if found.replace(address).is_some() {
                    return Err(format!("Ambiguous type {name}"));
                }
            }
        }
        Ok(found)
    }
    pub fn offset(&self, ty: u64, name: &str) -> Result<u64, String> {
        let f = self.field(ty, name)?;
        if f.data.is_static != 0 {
            return Err("Instance offset required".into());
        }
        Ok(f.data.offset as u64 + self.runtime.target().pointer_size as u64)
    }
    pub fn static_named_slot(&self, ty: u64, name: &str) -> Result<u64, String> {
        self.static_slot(&self.field(ty, name)?)?
            .ok_or("Static field is not initialized".into())
    }
    pub fn static_slot(&self, field: &NamedField) -> Result<Option<u64>, String> {
        let f = &field.data;
        if f.is_static == 0 || f.thread_local != 0 || f.context_local != 0 {
            return Err("Regular static field required".into());
        }
        if self.runtime.collectible(f.owner)? {
            return Err("Collectible static layout not supported by this runtime adapter".into());
        }
        let owner = self.runtime.type_data(f.owner)?;
        let local = self.runtime.domain_local(owner.module)?;
        let rid = owner.token & 0xffffff;
        if rid == 0 || local.class_data == 0 {
            return Ok(None);
        }
        let flags = self
            .runtime
            .target()
            .read(local.class_data + rid as u64 - 1, 1)?[0];
        if flags & 1 == 0 {
            return Ok(None);
        }
        let primitive = matches!(f.element, 2..=13 | 24 | 25);
        let base = if primitive {
            local.non_gc_statics
        } else {
            local.gc_statics
        };
        if base == 0 {
            return Ok(None);
        }
        Ok(Some(
            base.checked_add(f.offset as u64)
                .ok_or("Static address overflow")?,
        ))
    }
    pub fn static_object(&self, field: &NamedField) -> Result<Option<u64>, String> {
        let Some(slot) = self.static_slot(field)? else {
            return Ok(None);
        };
        let value = self.runtime.target().pointer(slot)?;
        Ok((value != 0).then_some(value))
    }
    pub fn instance_address(
        &self,
        object: u64,
        field: &NamedField,
        interior: bool,
    ) -> Result<u64, String> {
        if field.data.is_static != 0 || object < 0x10000 {
            return Err("Instance field/object required".into());
        }
        object
            .checked_add(if interior {
                0
            } else {
                self.runtime.target().pointer_size as u64
            })
            .and_then(|v| v.checked_add(field.data.offset as u64))
            .ok_or("Field address overflow".into())
    }
    pub fn object_type(&self, object: u64) -> Result<u64, String> {
        if object == 0 {
            return Err("Null managed object".into());
        }
        Ok(self.runtime.object_data(object)?.method_table)
    }
    pub fn object_field(&self, object: u64, name: &str) -> Result<u64, String> {
        if object == 0 {
            return Ok(0);
        }
        let field = self.field(self.object_type(object)?, name)?;
        if !matches!(field.data.element, 14 | 18 | 20 | 28 | 29) {
            return Err(format!("Object field required: {name}"));
        }
        self.runtime
            .target()
            .pointer(self.instance_address(object, &field, false)?)
    }
    pub fn array(&self, object: u64, limit: usize) -> Result<(ObjectData, Vec<u64>), String> {
        let data = self.runtime.object_data(object)?;
        if data.kind != 3
            || data.rank != 1
            || data.length > limit as u64
            || data.component_size != self.runtime.target().pointer_size as u64
            || !matches!(data.element_type, 14 | 18 | 20 | 28 | 29)
        {
            return Err("Unexpected object array structure".into());
        }
        let mut values = Vec::with_capacity(data.length as usize);
        let bytes = self.runtime.target().read(
            data.array_data,
            data.length as usize * data.component_size as usize,
        )?;
        for chunk in bytes.chunks_exact(data.component_size as usize) {
            values.push(if chunk.len() == 8 {
                u64::from_le_bytes(chunk.try_into().unwrap())
            } else {
                u32::from_le_bytes(chunk.try_into().unwrap()) as u64
            });
        }
        Ok((data, values))
    }
    pub fn list(&self, object: u64, limit: usize) -> Result<Vec<u64>, String> {
        if object == 0 {
            return Ok(Vec::new());
        }
        let size = self.number_field(object, "_size")?;
        if size < 0 || size > limit as i64 {
            return Err("List count out of range".into());
        }
        let items = self.object_field(object, "_items")?;
        let (_, mut values) = self.array(items, limit.max(1024))?;
        if size as usize > values.len() {
            return Err("List count exceeds array length".into());
        }
        values.truncate(size as usize);
        Ok(values)
    }
    pub fn dictionary(&self, object: u64, limit: usize) -> Result<Dictionary, String> {
        let object_type = self.object_type(object)?;
        if !self
            .runtime
            .type_name(object_type)?
            .starts_with("System.Collections.Generic.Dictionary`2[")
        {
            return Err("Dictionary required".into());
        }
        let version = self.number_field(object, "_version")?;
        let count = self.number_field(object, "_count")?;
        if count < 0 || count > limit as i64 {
            return Err("Dictionary count exceeds limit".into());
        }
        let entries = self.object_field(object, "_entries")?;
        if entries == 0 && count == 0 {
            let result = Dictionary {
                object,
                object_type,
                entries,
                data: ObjectData::default(),
                version,
                count,
                rows: Vec::new(),
            };
            self.verify_dictionary(&result)?;
            return Ok(result);
        }
        let data = self.runtime.object_data(entries)?;
        if data.kind != 3
            || data.rank != 1
            || data.element_type != 17
            || data.length > limit.saturating_mul(2).clamp(64, 200000) as u64
            || data.length < count as u64
            || data.component_size < 12
            || data.component_size > 1024
            || data.element_type_handle == 0
        {
            return Err("Invalid dictionary entries structure".into());
        }
        let next = self.field(data.element_type_handle, "next")?;
        if next.data.element != 8 {
            return Err("Dictionary next must be Int32".into());
        }
        let payload = self.runtime.target().read(
            data.array_data,
            count as usize * data.component_size as usize,
        )?;
        let mut rows = Vec::new();
        for i in 0..count as u64 {
            let address = data.array_data + i * data.component_size;
            let offset = (i * data.component_size + next.data.offset as u64) as usize;
            let next = i32::from_le_bytes(
                payload
                    .get(offset..offset + 4)
                    .ok_or("Dictionary entry offset out of range")?
                    .try_into()
                    .unwrap(),
            );
            if next >= -1 {
                rows.push(address);
            }
        }
        let result = Dictionary {
            object,
            object_type,
            entries,
            data,
            version,
            count,
            rows,
        };
        self.verify_dictionary(&result)?;
        Ok(result)
    }
    pub fn verify_dictionary(&self, d: &Dictionary) -> Result<(), String> {
        if self.number_field(d.object, "_version")? != d.version
            || self.number_field(d.object, "_count")? != d.count
            || self.object_field(d.object, "_entries")? != d.entries
        {
            return Err("Dictionary changed during read".into());
        }
        Ok(())
    }
    pub fn entry_object(&self, d: &Dictionary, address: u64, name: &str) -> Result<u64, String> {
        let f = self.field(d.data.element_type_handle, name)?;
        if !matches!(f.data.element, 14 | 18 | 20 | 28 | 29) {
            return Err("Reference dictionary entry field required".into());
        }
        self.runtime
            .target()
            .pointer(self.instance_address(address, &f, true)?)
    }
    pub fn string_field(
        &self,
        object: u64,
        name: &str,
        max: usize,
    ) -> Result<Option<String>, String> {
        let reference = self.object_field(object, name)?;
        if reference == 0 {
            return Ok(None);
        }
        Ok(Some(self.runtime.string(reference, max)?))
    }
    pub fn c_string(&self, address: u64, max: usize) -> Result<String, String> {
        if max > 4096 {
            return Err("Native string exceeds limit".into());
        }
        let mut data = Vec::new();
        for i in 0..max {
            let b = self.runtime.target().read(address + i as u64, 1)?[0];
            if b == 0 {
                return String::from_utf8(data).map_err(|_| "Invalid native UTF8".into());
            }
            data.push(b);
        }
        Err("Unterminated native string".into())
    }
    pub fn numeric_description(
        &self,
        field: &NamedField,
        interior: bool,
    ) -> Result<NumericField, String> {
        let mut element = field.data.element;
        let mut names = BTreeMap::new();
        if field.data.field_type != 0 {
            let ty = self.runtime.type_data(field.data.field_type)?;
            names = self.metadata(ty.module, |m| m.enum_values(ty.token))?;
            if !names.is_empty() {
                element = self.field(field.data.field_type, "value__")?.data.element;
            }
        }
        let (size, signed) = match element {
            2 | 5 => (1, false),
            4 => (1, true),
            3 | 7 => (2, false),
            6 => (2, true),
            9 => (4, false),
            8 => (4, true),
            11 => (8, false),
            10 => (8, true),
            24 => (self.runtime.target().pointer_size as usize, true),
            25 => (self.runtime.target().pointer_size as usize, false),
            _ => return Err(format!("Unsupported numeric element {element}")),
        };
        Ok(NumericField {
            offset: field.data.offset as u64
                + if interior {
                    0
                } else {
                    self.runtime.target().pointer_size as u64
                },
            size,
            signed,
            names,
        })
    }
    pub fn number(&self, address: u64, size: usize, signed: bool) -> Result<i64, String> {
        let bytes = self.runtime.target().read(address, size)?;
        Ok(match (size, signed) {
            (1, true) => bytes[0] as i8 as i64,
            (1, false) => bytes[0] as i64,
            (2, true) => i16::from_le_bytes(bytes.try_into().unwrap()) as i64,
            (2, false) => u16::from_le_bytes(bytes.try_into().unwrap()) as i64,
            (4, true) => i32::from_le_bytes(bytes.try_into().unwrap()) as i64,
            (4, false) => u32::from_le_bytes(bytes.try_into().unwrap()) as i64,
            (8, true) => i64::from_le_bytes(bytes.try_into().unwrap()),
            (8, false) => i64::try_from(u64::from_le_bytes(bytes.try_into().unwrap()))
                .map_err(|_| "Unsigned value exceeds range")?,
            _ => return Err("Invalid numeric width".into()),
        })
    }
    pub fn number_field(&self, object: u64, name: &str) -> Result<i64, String> {
        let field = self.field(self.object_type(object)?, name)?;
        let desc = self.numeric_description(&field, false)?;
        self.number(object + desc.offset, desc.size, desc.signed)
    }
    pub fn optional_enum(
        &self,
        object: u64,
        field: &NamedField,
    ) -> Result<Option<(i64, BTreeMap<i64, String>)>, String> {
        if field.data.element != 17 {
            let desc = self.numeric_description(field, false)?;
            return Ok(Some((
                self.number(object + desc.offset, desc.size, desc.signed)?,
                desc.names,
            )));
        }
        let ty = field.data.field_type;
        if !self
            .runtime
            .type_name(ty)?
            .starts_with("System.Nullable`1[")
        {
            return Err("Expected nullable enum".into());
        }
        let has = self.field(ty, "hasValue")?;
        let value = self.field(ty, "value")?;
        let address = self.instance_address(object, field, false)?;
        let has_desc = self.numeric_description(&has, true)?;
        if self.number(address + has_desc.offset, has_desc.size, has_desc.signed)? == 0 {
            return Ok(None);
        }
        let desc = self.numeric_description(&value, true)?;
        Ok(Some((
            self.number(address + desc.offset, desc.size, desc.signed)?,
            desc.names,
        )))
    }
    pub fn float_field(&self, object: u64, name: &str) -> Result<f32, String> {
        let field = self.field(self.object_type(object)?, name)?;
        if field.data.element != 12 {
            return Err("Float field required".into());
        }
        let bytes = self
            .runtime
            .target()
            .read(self.instance_address(object, &field, false)?, 4)?;
        let value = f32::from_le_bytes(bytes.try_into().unwrap());
        if !value.is_finite() {
            return Err("Non-finite float".into());
        }
        Ok(value)
    }
    pub fn module_leaf(module: &Module) -> String {
        module
            .name
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_owned()
    }
}
