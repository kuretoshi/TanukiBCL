use crate::{
    abi::*,
    target::{self, Target},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::c_void,
    mem,
    os::windows::ffi::OsStrExt,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{Foundation::*, System::LibraryLoader::*};

pub struct Runtime {
    // Drop COM objects before the library and their data target.
    process: Option<Com>,
    sos: Option<Com>,
    sos6: Option<Com>,
    target: *mut Target,
    library: HMODULE,
}
#[derive(Debug, Serialize, Clone)]
pub struct Module {
    pub address: u64,
    pub app_domain: u64,
    pub name: String,
    #[serde(skip)]
    pub data: ModuleData,
}
#[derive(Debug, Serialize, Clone)]
pub struct Type {
    pub address: u64,
    pub token: u32,
    pub name: String,
}
#[derive(Debug, Clone)]
pub struct Field {
    pub data: FieldData,
}

impl Runtime {
    pub fn attach(pid: u32) -> Result<Self, String> {
        let target = Target::open(pid)?;
        let mut runtime = Self {
            process: None,
            sos: None,
            sos6: None,
            target,
            library: null_mut(),
        };
        let path = runtime.target().dac_path()?;
        let _verified_dac = target::verify_dac(&path)?;
        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            runtime.library = LoadLibraryExW(
                path.as_ptr(),
                null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if runtime.library.is_null() {
                return Err(format!("Load DAC: {}", GetLastError()));
            }
            if GetProcAddress(runtime.library, b"DAC_PAL_InitializeDLL\0".as_ptr()).is_some()
                || GetProcAddress(runtime.library, b"PAL_InitializeDLL\0".as_ptr()).is_some()
            {
                let entry = GetProcAddress(runtime.library, b"DllMain\0".as_ptr())
                    .ok_or("DAC DllMain missing")?;
                let init: unsafe extern "system" fn(HMODULE, u32, *const c_void) -> i32 =
                    mem::transmute(entry);
                if init(runtime.library, 1, null()) == 0 {
                    return Err("DAC initialization failed".into());
                }
            }
            let entry = GetProcAddress(runtime.library, b"CLRDataCreateInstance\0".as_ptr())
                .ok_or("CLRDataCreateInstance missing")?;
            let create: unsafe extern "system" fn(
                *const windows_sys::core::GUID,
                *mut c_void,
                *mut *mut c_void,
            ) -> Hr = mem::transmute(entry);
            let mut process = null_mut();
            check(
                create(&DATA_PROCESS, target.cast(), &mut process),
                "CLRDataCreateInstance",
            )?;
            if process.is_null() {
                return Err("Null CLR process interface".into());
            }
            runtime.process = Some(Com(process));
        }
        runtime.sos = Some(runtime.process.as_ref().unwrap().query(&SOS)?);
        runtime.sos6 = runtime.sos.as_ref().unwrap().query(&SOS6).ok();
        Ok(runtime)
    }
    pub fn target(&self) -> &Target {
        unsafe { &*self.target }
    }
    fn address(&self, address: u64) -> u64 {
        if self.target().pointer_size == 4 {
            address as u32 as u64
        } else {
            address
        }
    }
    fn wire(&self, address: u64) -> u64 {
        if self.target().pointer_size == 4 {
            address as u32 as i32 as i64 as u64
        } else {
            address
        }
    }
    fn sos(&self) -> &Com {
        self.sos.as_ref().unwrap()
    }
    pub fn flush(&self) -> Result<(), String> {
        if !self.target().alive() {
            return Err("Target process ended or changed".into());
        }
        let process = self.process.as_ref().unwrap();
        let f: unsafe extern "system" fn(*mut c_void) -> Hr =
            unsafe { mem::transmute(process.slot(3)) };
        check(unsafe { f(process.0) }, "Flush")
    }
    fn data<T: Default + AddressFields>(
        &self,
        slot: usize,
        address: u64,
        label: &str,
    ) -> Result<T, String> {
        let mut result = T::default();
        let sos = self.sos();
        let f: unsafe extern "system" fn(*mut c_void, u64, *mut T) -> Hr =
            unsafe { mem::transmute(sos.slot(slot)) };
        check(unsafe { f(sos.0, self.wire(address), &mut result) }, label)?;
        result.normalize(self.target().pointer_size);
        Ok(result)
    }
    pub fn module_data(&self, address: u64) -> Result<ModuleData, String> {
        self.data(13, address, "GetModuleData")
    }
    pub fn type_data(&self, address: u64) -> Result<MethodTableData, String> {
        self.data(37, address, "GetMethodTableData")
    }
    pub fn object_data(&self, address: u64) -> Result<ObjectData, String> {
        self.data(33, address, "GetObjectData")
    }
    pub fn field_data(&self, address: u64) -> Result<FieldData, String> {
        self.data(42, address, "GetFieldDescData")
    }
    pub fn domain_local(&self, module: u64) -> Result<DomainLocalData, String> {
        self.data(57, module, "GetDomainLocalModuleDataFromModule")
    }
    pub fn collectible(&self, address: u64) -> Result<bool, String> {
        let sos = self
            .sos6
            .as_ref()
            .ok_or("Collectible type inspection unavailable")?;
        let mut data = CollectibleData::default();
        let f: unsafe extern "system" fn(*mut c_void, u64, *mut CollectibleData) -> Hr =
            unsafe { mem::transmute(sos.slot(3)) };
        check(
            unsafe { f(sos.0, self.wire(address), &mut data) },
            "GetMethodTableCollectibleData",
        )?;
        Ok(data.collectible != 0)
    }
    fn name(&self, slot: usize, address: u64) -> Result<String, String> {
        let sos = self.sos();
        let mut chars = vec![0u16; 32768];
        let mut needed = 0;
        let f: unsafe extern "system" fn(*mut c_void, u64, u32, *mut u16, *mut u32) -> Hr =
            unsafe { mem::transmute(sos.slot(slot)) };
        check(
            unsafe {
                f(
                    sos.0,
                    self.wire(address),
                    chars.len() as u32,
                    chars.as_mut_ptr(),
                    &mut needed,
                )
            },
            "DAC name",
        )?;
        if needed > chars.len() as u32 {
            return Err("DAC name too long".into());
        }
        let end = chars
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(needed as usize);
        String::from_utf16(&chars[..end]).map_err(|_| "Invalid UTF16 name".into())
    }
    pub fn type_name(&self, address: u64) -> Result<String, String> {
        self.name(36, address)
    }
    pub fn string(&self, address: u64, max: usize) -> Result<String, String> {
        if address == 0 {
            return Ok(String::new());
        }
        if max > 32768 {
            return Err("String read exceeds limit".into());
        }
        let data = self.object_data(address)?;
        if data.kind != 0 {
            return Err("Managed string required".into());
        }
        let len = self
            .target()
            .read(address + self.target().pointer_size as u64, 4)?;
        let len = u32::from_le_bytes(len.try_into().unwrap()) as usize;
        if len > max {
            return Err("Managed string too long".into());
        }
        let sos = self.sos();
        let mut chars = vec![0u16; len + 1];
        let mut needed = 0;
        let f: unsafe extern "system" fn(*mut c_void, u64, u32, *mut u16, *mut u32) -> Hr =
            unsafe { mem::transmute(sos.slot(34)) };
        check(
            unsafe {
                f(
                    sos.0,
                    self.wire(address),
                    chars.len() as u32,
                    chars.as_mut_ptr(),
                    &mut needed,
                )
            },
            "GetObjectStringData",
        )?;
        // CoreCLR's implementation returns ReadVirtual's byte count here,
        // although the input count is measured in WCHARs.
        if needed as usize != chars.len() * 2 {
            return Err("Managed string changed or was truncated during read".into());
        }
        String::from_utf16(&chars[..len]).map_err(|_| "Invalid managed UTF16".into())
    }
    pub fn modules(&self) -> Result<Vec<Module>, String> {
        let sos = self.sos();
        let domains: unsafe extern "system" fn(*mut c_void, u32, *mut u64, *mut u32) -> Hr =
            unsafe { mem::transmute(sos.slot(5)) };
        let assemblies: unsafe extern "system" fn(*mut c_void, u64, i32, *mut u64, *mut i32) -> Hr =
            unsafe { mem::transmute(sos.slot(9)) };
        let modules: unsafe extern "system" fn(*mut c_void, u64, u32, *mut u64, *mut u32) -> Hr =
            unsafe { mem::transmute(sos.slot(15)) };
        let mut store = AppDomainStore::default();
        let get_store: unsafe extern "system" fn(*mut c_void, *mut AppDomainStore) -> Hr =
            unsafe { mem::transmute(sos.slot(4)) };
        check(
            unsafe { get_store(sos.0, &mut store) },
            "GetAppDomainStoreData",
        )?;
        let mut count = store.count as u32;
        if count == 0 || count > 64 {
            return Err("Invalid AppDomain count".into());
        }
        let mut ds = vec![0u64; count as usize];
        check(
            unsafe { domains(sos.0, count, ds.as_mut_ptr(), &mut count) },
            "GetAppDomainList",
        )?;
        if count as usize > ds.len() {
            return Err("AppDomains changed".into());
        }
        let mut result = Vec::new();
        let mut seen = BTreeSet::new();
        for domain in ds.into_iter().take(count as usize).map(|a| self.address(a)) {
            let domain_data: AppDomainData = self.data(6, domain, "GetAppDomainData")?;
            let mut count = domain_data.assemblies;
            if !(0..=4096).contains(&count) {
                return Err("Invalid assembly count".into());
            }
            let mut aa = vec![0u64; count as usize];
            check(
                unsafe { assemblies(sos.0, self.wire(domain), count, aa.as_mut_ptr(), &mut count) },
                "GetAssemblyList",
            )?;
            if count as usize > aa.len() {
                return Err("Assemblies changed".into());
            }
            for assembly in aa.into_iter().take(count as usize).map(|a| self.address(a)) {
                let mut assembly_data = AssemblyData::default();
                let get_assembly: unsafe extern "system" fn(
                    *mut c_void,
                    u64,
                    u64,
                    *mut AssemblyData,
                ) -> Hr = unsafe { mem::transmute(sos.slot(10)) };
                check(
                    unsafe {
                        get_assembly(
                            sos.0,
                            self.wire(domain),
                            self.wire(assembly),
                            &mut assembly_data,
                        )
                    },
                    "GetAssemblyData",
                )?;
                let mut count = assembly_data.module_count;
                if count > 128 {
                    return Err("Invalid module count".into());
                }
                let mut mm = vec![0u64; count as usize];
                check(
                    unsafe {
                        modules(
                            sos.0,
                            self.wire(assembly),
                            count,
                            mm.as_mut_ptr(),
                            &mut count,
                        )
                    },
                    "GetAssemblyModuleList",
                )?;
                if count as usize > mm.len() {
                    return Err("Modules changed".into());
                }
                for address in mm.into_iter().take(count as usize).map(|a| self.address(a)) {
                    if address == 0 || !seen.insert(address) {
                        continue;
                    }
                    let data = self.module_data(address)?;
                    let name = self.name(45, data.file).unwrap_or_default();
                    result.push(Module {
                        address,
                        app_domain: domain,
                        name,
                        data,
                    });
                    if result.len() > 4096 {
                        return Err("Module limit exceeded".into());
                    }
                }
            }
        }
        Ok(result)
    }
    pub fn type_map(&self, module: u64) -> Result<Vec<(u32, u64)>, String> {
        unsafe extern "system" fn collect(token: u32, address: u64, context: *mut c_void) {
            let map = &mut *(context as *mut BTreeMap<u64, u32>);
            if map.len() < 100_000 && address != 0 {
                map.insert(address, token);
            }
        }
        let mut map = BTreeMap::<u64, u32>::new();
        let sos = self.sos();
        let f: unsafe extern "system" fn(
            *mut c_void,
            i32,
            u64,
            unsafe extern "system" fn(u32, u64, *mut c_void),
            *mut c_void,
        ) -> Hr = unsafe { mem::transmute(sos.slot(14)) };
        check(
            unsafe {
                f(
                    sos.0,
                    0,
                    self.wire(module),
                    collect,
                    (&mut map as *mut BTreeMap<u64, u32>).cast(),
                )
            },
            "TraverseModuleMap",
        )?;
        if map.len() >= 100_000 {
            return Err("Type limit exceeded".into());
        }
        Ok(map
            .into_iter()
            .map(|(address, token)| (token & 0xffffff, self.address(address)))
            .collect())
    }
    pub fn types(&self, module: u64) -> Result<Vec<Type>, String> {
        self.type_map(module)?
            .into_iter()
            .map(|(token, address)| {
                Ok(Type {
                    address,
                    token,
                    name: self.type_name(address)?,
                })
            })
            .collect()
    }
    pub fn fields(&self, method_table: u64) -> Result<Vec<Field>, String> {
        let mut result = Vec::new();
        let mut visited = BTreeSet::new();
        let mut table = method_table;
        for _ in 0..64 {
            if table == 0 {
                return Ok(result);
            }
            if !visited.insert(table) {
                return Err("Cyclic type hierarchy".into());
            }
            let data = self.type_data(table)?;
            let fields: FieldsData = self.data(39, table, "GetMethodTableFieldData")?;
            let inherited: FieldsData = if data.parent != 0 {
                self.data(39, data.parent, "GetMethodTableFieldData parent")?
            } else {
                FieldsData::default()
            };
            let instance_count = fields
                .instance_count
                .checked_sub(inherited.instance_count)
                .ok_or("Invalid inherited field count")?;
            let count = instance_count as usize + fields.static_count as usize;
            if count > 4096 {
                return Err("Field count exceeds limit".into());
            }
            let mut current = fields.first;
            let mut seen = BTreeSet::new();
            for _ in 0..count {
                if current == 0 {
                    return Err("Truncated field list".into());
                }
                if !seen.insert(current) || seen.len() > 4096 {
                    return Err("Invalid field list".into());
                }
                let field = self.field_data(current)?;
                // FirstField traverses only fields declared by this class. Some
                // runtime versions use a terminating address beyond this class.
                if field.owner != table {
                    // Reference-type generic instantiations share FieldDescs
                    // with their canonical MethodTable. Require metadata identity.
                    let owner = self.type_data(field.owner)?;
                    if owner.module != data.module || owner.token != data.token {
                        return Err("Field owner changed".into());
                    }
                }
                result.push(Field { data: field });
                current = field.next;
            }
            table = data.parent;
        }
        Err("Type hierarchy too deep".into())
    }
    pub fn handles(&self) -> Result<Vec<HandleData>, String> {
        let sos = self.sos();
        let mut p = null_mut();
        let f: unsafe extern "system" fn(*mut c_void, *mut *mut c_void) -> Hr =
            unsafe { mem::transmute(sos.slot(61)) };
        check(unsafe { f(sos.0, &mut p) }, "GetHandleEnum")?;
        if p.is_null() {
            return Err("Null handle enumerator".into());
        }
        let en = Com(p);
        let next: unsafe extern "system" fn(*mut c_void, u32, *mut HandleData, *mut u32) -> Hr =
            unsafe { mem::transmute(en.slot(6)) };
        let mut result = Vec::new();
        loop {
            let mut chunk = [HandleData::default(); 256];
            let mut got = 0;
            check(
                unsafe { next(en.0, chunk.len() as u32, chunk.as_mut_ptr(), &mut got) },
                "Handle Next",
            )?;
            if got as usize > chunk.len() || result.len() + got as usize > 100_000 {
                return Err("Handle limit exceeded".into());
            }
            for handle in &mut chunk[..got as usize] {
                handle.normalize(self.target().pointer_size);
            }
            result.extend_from_slice(&chunk[..got as usize]);
            if got < chunk.len() as u32 {
                break;
            }
        }
        Ok(result)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        drop(self.sos6.take());
        drop(self.sos.take());
        drop(self.process.take());
        unsafe {
            if !self.library.is_null() {
                FreeLibrary(self.library);
            }
            if !self.target.is_null() {
                target::release(self.target.cast());
            }
        }
    }
}
