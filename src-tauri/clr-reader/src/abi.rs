//! Stable DAC ABI, from dotnet/runtime v6.0.36 clrdata.idl, sospriv.idl and
//! dacprivate.h (MIT). CLRDATA_ADDRESS remains u64 for both x86 and x64.
use std::ffi::c_void;
use windows_sys::core::GUID;

pub type Hr = i32;
pub const IUNKNOWN: GUID = GUID::from_u128(0x00000000_0000_0000_c000_000000000046);
pub const DATA_TARGET: GUID = GUID::from_u128(0x3e11ccee_d08b_43e5_af01_32717a64da03);
pub const DATA_PROCESS: GUID = GUID::from_u128(0x5c552ab6_fc09_4cb3_8e36_22fa03c798b7);
pub const SOS: GUID = GUID::from_u128(0x436f00f2_b42a_4b9f_870c_e73db66ae930);
pub const SOS6: GUID = GUID::from_u128(0x11206399_4b66_4edb_98ea_85654e59ad45);
pub const E_FAIL: Hr = 0x80004005u32 as i32;
pub const E_NOTIMPL: Hr = 0x80004001u32 as i32;
pub const E_NOINTERFACE: Hr = 0x80004002u32 as i32;
pub const E_INVALIDARG: Hr = 0x80070057u32 as i32;
pub const E_ACCESSDENIED: Hr = 0x80070005u32 as i32;

#[repr(C)]
pub struct TargetVtable {
    pub query: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> Hr,
    pub add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    pub release: unsafe extern "system" fn(*mut c_void) -> u32,
    pub machine: unsafe extern "system" fn(*mut c_void, *mut u32) -> Hr,
    pub pointer_size: unsafe extern "system" fn(*mut c_void, *mut u32) -> Hr,
    pub image_base: unsafe extern "system" fn(*mut c_void, *const u16, *mut u64) -> Hr,
    pub read: unsafe extern "system" fn(*mut c_void, u64, *mut u8, u32, *mut u32) -> Hr,
    pub write: unsafe extern "system" fn(*mut c_void, u64, *const u8, u32, *mut u32) -> Hr,
    pub get_tls: unsafe extern "system" fn(*mut c_void, u32, u32, *mut u64) -> Hr,
    pub set_tls: unsafe extern "system" fn(*mut c_void, u32, u32, u64) -> Hr,
    pub current_thread: unsafe extern "system" fn(*mut c_void, *mut u32) -> Hr,
    pub get_context: unsafe extern "system" fn(*mut c_void, u32, u32, u32, *mut u8) -> Hr,
    pub set_context: unsafe extern "system" fn(*mut c_void, u32, u32, *const u8) -> Hr,
    pub request: unsafe extern "system" fn(*mut c_void, u32, u32, *const u8, u32, *mut u8) -> Hr,
}

// COM pointers are owned, non-Send and released before the DAC library unloads.
pub struct Com(pub *mut c_void);
impl Com {
    pub unsafe fn slot(&self, index: usize) -> *const c_void {
        *(*(self.0 as *const *const *const c_void)).add(index)
    }
    pub fn query(&self, iid: &GUID) -> Result<Com, String> {
        let mut p = std::ptr::null_mut();
        let f: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> Hr =
            unsafe { std::mem::transmute(self.slot(0)) };
        check(unsafe { f(self.0, iid, &mut p) }, "QueryInterface")?;
        if p.is_null() {
            return Err("Null COM interface".into());
        }
        Ok(Com(p))
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if !self.0.is_null() {
            let f: unsafe extern "system" fn(*mut c_void) -> u32 =
                unsafe { std::mem::transmute(self.slot(2)) };
            unsafe {
                f(self.0);
            }
        }
    }
}
pub fn check(hr: Hr, name: &str) -> Result<(), String> {
    if hr < 0 {
        Err(format!("{name}: HRESULT 0x{:08X}", hr as u32))
    } else {
        Ok(())
    }
}

#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct ModuleData {
    pub address: u64,
    pub file: u64,
    pub il_base: u64,
    pub metadata: u64,
    pub metadata_size: u64,
    pub assembly: u64,
    pub reflection: i32,
    pub pe_file: i32,
    pub base_class_index: u64,
    pub module_id: u64,
    pub transient_flags: u32,
    pub type_def_map: u64,
    pub type_ref_map: u64,
    pub method_map: u64,
    pub field_map: u64,
    pub member_ref_map: u64,
    pub file_ref_map: u64,
    pub manifest_map: u64,
    pub lookup_heap: u64,
    pub thunk_heap: u64,
    pub module_index: u64,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct MethodTableData {
    pub free: i32,
    pub module: u64,
    pub class: u64,
    pub parent: u64,
    pub interfaces: u16,
    pub methods: u16,
    pub slots: u16,
    pub virtuals: u16,
    pub base_size: u32,
    pub component_size: u32,
    pub token: u32,
    pub attributes: u32,
    pub shared: i32,
    pub dynamic: i32,
    pub contains_pointers: i32,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct ObjectData {
    pub method_table: u64,
    pub kind: i32,
    pub size: u64,
    pub element_type_handle: u64,
    pub element_type: i32,
    pub rank: u32,
    pub length: u64,
    pub component_size: u64,
    pub array_data: u64,
    pub bounds: u64,
    pub lower_bounds: u64,
    pub rcw: u64,
    pub ccw: u64,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct FieldData {
    pub element: i32,
    pub signature_element: i32,
    pub field_type: u64,
    pub module: u64,
    pub type_token: u32,
    pub token: u32,
    pub owner: u64,
    pub offset: u32,
    pub thread_local: i32,
    pub context_local: i32,
    pub is_static: i32,
    pub next: u64,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct FieldsData {
    pub instance_count: u16,
    pub static_count: u16,
    pub thread_static_count: u16,
    pub first: u64,
    pub context_offset: u16,
    pub context_size: u16,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct DomainLocalData {
    pub app_domain: u64,
    pub module_id: u64,
    pub class_data: u64,
    pub dynamic_class_table: u64,
    pub gc_statics: u64,
    pub non_gc_statics: u64,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct CollectibleData {
    pub loader_handle: u64,
    pub collectible: i32,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct HandleData {
    pub app_domain: u64,
    pub handle: u64,
    pub secondary: u64,
    pub kind: u32,
    pub strong: i32,
    pub ref_count: u32,
    pub jupiter_ref_count: u32,
    pub pegged: i32,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct AppDomainStore {
    pub shared: u64,
    pub system: u64,
    pub count: i32,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct AppDomainData {
    pub address: u64,
    pub security: u64,
    pub low_heap: u64,
    pub high_heap: u64,
    pub stub_heap: u64,
    pub local_block: u64,
    pub local_modules: u64,
    pub id: u32,
    pub assemblies: i32,
    pub failed_assemblies: i32,
    pub stage: i32,
}
#[repr(C)]
#[derive(Default, Debug, Clone, Copy)]
pub struct AssemblyData {
    pub address: u64,
    pub loader: u64,
    pub parent_domain: u64,
    pub base_domain: u64,
    pub security: u64,
    pub dynamic: i32,
    pub module_count: u32,
    pub context: u32,
    pub neutral: i32,
    pub location_flags: u32,
}
pub trait AddressFields {
    fn normalize(&mut self, pointer_size: u32);
}
macro_rules! addresses {
    ($ty:ty,$($field:ident),*) => {impl AddressFields for $ty {fn normalize(&mut self,pointer_size:u32){if pointer_size==4 {$(self.$field=self.$field as u32 as u64;)*}}}};
}
addresses!(
    ModuleData,
    address,
    file,
    il_base,
    metadata,
    assembly,
    type_def_map,
    type_ref_map,
    method_map,
    field_map,
    member_ref_map,
    file_ref_map,
    manifest_map,
    lookup_heap,
    thunk_heap
);
addresses!(MethodTableData, module, class, parent);
addresses!(
    ObjectData,
    method_table,
    element_type_handle,
    array_data,
    bounds,
    lower_bounds,
    rcw,
    ccw
);
addresses!(FieldData, field_type, module, owner, next);
addresses!(FieldsData, first);
addresses!(
    DomainLocalData,
    app_domain,
    class_data,
    dynamic_class_table,
    gc_statics,
    non_gc_statics
);
addresses!(
    AppDomainData,
    address,
    security,
    low_heap,
    high_heap,
    stub_heap,
    local_block,
    local_modules
);
addresses!(HandleData, app_domain, handle, secondary);

// These sizes are ABI invariants, not application-layout assumptions.
const _: () = {
    assert!(std::mem::size_of::<ModuleData>() == 0xa0);
    assert!(std::mem::size_of::<MethodTableData>() == 0x48);
    assert!(std::mem::size_of::<ObjectData>() == 0x60);
    assert!(std::mem::size_of::<FieldData>() == 0x40);
    assert!(std::mem::size_of::<FieldsData>() == 0x18);
    assert!(std::mem::size_of::<DomainLocalData>() == 0x30);
    assert!(std::mem::size_of::<CollectibleData>() == 0x10);
    assert!(std::mem::size_of::<HandleData>() == 0x30);
    assert!(std::mem::size_of::<AppDomainStore>() == 0x18);
    assert!(std::mem::size_of::<AppDomainData>() == 0x48);
    assert!(std::mem::size_of::<AssemblyData>() == 0x40);
};
