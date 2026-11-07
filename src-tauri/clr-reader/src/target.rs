use crate::abi::*;
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    path::{Path, PathBuf},
    ptr::null_mut,
    sync::atomic::{AtomicU32, Ordering},
};
use windows_sys::{
    core::GUID,
    Win32::{
        Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
        System::{
            Diagnostics::{Debug::ReadProcessMemory, ToolHelp::*},
            Threading::*,
        },
    },
};

#[derive(Debug)]
pub struct Module {
    pub name: String,
    pub path: PathBuf,
    pub base: u64,
}
#[repr(C)]
pub struct Target {
    vtable: *const TargetVtable,
    refs: AtomicU32,
    pub handle: HANDLE,
    pub modules: Vec<Module>,
    pub started: u64,
    pub pointer_size: u32,
}
impl Target {
    pub fn open(pid: u32) -> Result<*mut Target, String> {
        unsafe {
            let handle = OpenProcess(
                PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if handle.is_null() {
                return Err(format!("OpenProcess: {}", GetLastError()));
            }
            let result = (|| {
                let mut path = vec![0u16; 32768];
                let mut length = path.len() as u32;
                if QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut length) == 0 {
                    return Err("Cannot identify target executable".into());
                }
                let path = PathBuf::from(String::from_utf16_lossy(&path[..length as usize]));
                if !path
                    .file_name()
                    .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("Among Us.exe"))
                {
                    return Err("Among Us process required".into());
                }
                let started = start_time(handle)?;
                let snapshot =
                    CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
                if snapshot == INVALID_HANDLE_VALUE {
                    return Err(format!("Module snapshot: {}", GetLastError()));
                }
                let mut entry: MODULEENTRY32W = zeroed();
                entry.dwSize = size_of::<MODULEENTRY32W>() as u32;
                let mut modules = Vec::new();
                let mut success = Module32FirstW(snapshot, &mut entry);
                while success != 0 && modules.len() < 4096 {
                    modules.push(Module {
                        name: wide(&entry.szModule),
                        path: PathBuf::from(wide(&entry.szExePath)),
                        base: entry.modBaseAddr as u64,
                    });
                    success = Module32NextW(snapshot, &mut entry);
                }
                CloseHandle(snapshot);
                let core = modules
                    .iter()
                    .find(|m| m.name.eq_ignore_ascii_case("coreclr.dll"))
                    .ok_or("CoreCLR not found")?;
                let mut header = [0u8; 64];
                read_exact(handle, core.base, &mut header)?;
                if &header[..2] != b"MZ" {
                    return Err("Invalid CoreCLR image".into());
                }
                let pe = u32::from_le_bytes(header[60..64].try_into().unwrap()) as u64;
                if pe > 0x100000 {
                    return Err("Invalid PE header offset".into());
                }
                let mut machine = [0u8; 6];
                read_exact(handle, core.base + pe, &mut machine)?;
                if &machine[..4] != b"PE\0\0" {
                    return Err("Invalid PE signature".into());
                }
                let pointer_size = match u16::from_le_bytes([machine[4], machine[5]]) {
                    0x8664 => 8,
                    0x14c => 4,
                    _ => return Err("Unsupported CoreCLR architecture".into()),
                };
                if pointer_size as usize != size_of::<usize>() {
                    return Err("Use the CLR reader matching the target architecture".into());
                }
                Ok(Box::into_raw(Box::new(Target {
                    vtable: &VTABLE,
                    refs: AtomicU32::new(1),
                    handle,
                    modules,
                    started,
                    pointer_size,
                })))
            })();
            if result.is_err() {
                CloseHandle(handle);
            }
            result
        }
    }
    pub fn read(&self, address: u64, length: usize) -> Result<Vec<u8>, String> {
        if length > 32 * 1024 * 1024 {
            return Err("Read limit exceeded".into());
        }
        let mut data = vec![0u8; length];
        unsafe {
            read_exact(self.handle, address, &mut data)?;
        }
        Ok(data)
    }
    pub fn pointer(&self, address: u64) -> Result<u64, String> {
        let bytes = self.read(address, self.pointer_size as usize)?;
        Ok(if self.pointer_size == 8 {
            u64::from_le_bytes(bytes.try_into().unwrap())
        } else {
            u32::from_le_bytes(bytes.try_into().unwrap()) as u64
        })
    }
    pub fn alive(&self) -> bool {
        unsafe {
            WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT
                && start_time(self.handle).ok() == Some(self.started)
        }
    }
    pub fn dac_path(&self) -> Result<PathBuf, String> {
        let core = self
            .modules
            .iter()
            .find(|m| m.name.eq_ignore_ascii_case("coreclr.dll"))
            .ok_or("CoreCLR not found")?;
        Ok(core
            .path
            .parent()
            .ok_or("CoreCLR directory missing")?
            .join("mscordaccore.dll"))
    }
}
impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}
fn wide(value: &[u16]) -> String {
    String::from_utf16_lossy(&value[..value.iter().position(|&c| c == 0).unwrap_or(value.len())])
}
pub unsafe fn start_time(handle: HANDLE) -> Result<u64, String> {
    let (mut c, mut e, mut k, mut u) = (zeroed(), zeroed(), zeroed(), zeroed());
    if GetProcessTimes(handle, &mut c, &mut e, &mut k, &mut u) == 0 {
        return Err("Cannot read process identity".into());
    }
    Ok(((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64)
}
unsafe fn read_exact(handle: HANDLE, address: u64, bytes: &mut [u8]) -> Result<(), String> {
    if address < 0x10000
        || address.checked_add(bytes.len() as u64).is_none()
        || address > usize::MAX as u64
    {
        return Err("Invalid address".into());
    }
    let mut count = 0;
    if ReadProcessMemory(
        handle,
        address as *const c_void,
        bytes.as_mut_ptr().cast(),
        bytes.len(),
        &mut count,
    ) == 0
        || count != bytes.len()
    {
        return Err(format!(
            "ReadProcessMemory at 0x{address:X}: {}",
            GetLastError()
        ));
    }
    Ok(())
}
unsafe extern "system" fn query(this: *mut c_void, iid: *const GUID, out: *mut *mut c_void) -> Hr {
    if iid.is_null() || out.is_null() {
        return E_INVALIDARG;
    }
    *out = null_mut();
    let same = |a: &GUID, b: &GUID| {
        a.data1 == b.data1 && a.data2 == b.data2 && a.data3 == b.data3 && a.data4 == b.data4
    };
    if !same(&*iid, &DATA_TARGET) && !same(&*iid, &IUNKNOWN) {
        return E_NOINTERFACE;
    }
    *out = this;
    add_ref(this);
    0
}
unsafe extern "system" fn add_ref(this: *mut c_void) -> u32 {
    (*(this as *mut Target))
        .refs
        .fetch_add(1, Ordering::Relaxed)
        + 1
}
pub unsafe extern "system" fn release(this: *mut c_void) -> u32 {
    let n = (*(this as *mut Target)).refs.fetch_sub(1, Ordering::AcqRel) - 1;
    if n == 0 {
        drop(Box::from_raw(this as *mut Target));
    }
    n
}
unsafe extern "system" fn machine(this: *mut c_void, out: *mut u32) -> Hr {
    if out.is_null() {
        return E_INVALIDARG;
    }
    *out = if (*(this as *mut Target)).pointer_size == 8 {
        0x8664
    } else {
        0x14c
    };
    0
}
unsafe extern "system" fn pointer_size(this: *mut c_void, out: *mut u32) -> Hr {
    if out.is_null() {
        return E_INVALIDARG;
    }
    *out = (*(this as *mut Target)).pointer_size;
    0
}
unsafe extern "system" fn image_base(this: *mut c_void, name: *const u16, out: *mut u64) -> Hr {
    if name.is_null() || out.is_null() {
        return E_INVALIDARG;
    }
    *out = 0;
    let mut length = 0;
    while length < 32768 && *name.add(length) != 0 {
        length += 1;
    }
    if length == 32768 {
        return E_INVALIDARG;
    }
    let name = String::from_utf16_lossy(std::slice::from_raw_parts(name, length));
    let full = name.contains(['/', '\\']);
    for module in &(*(this as *mut Target)).modules {
        let candidate = if full {
            module.path.to_string_lossy().into_owned()
        } else {
            module.name.clone()
        };
        if candidate.eq_ignore_ascii_case(&name) {
            *out = if (*(this as *mut Target)).pointer_size == 4 {
                module.base as u32 as i32 as i64 as u64
            } else {
                module.base
            };
            return 0;
        }
    }
    E_FAIL
}
unsafe extern "system" fn read(
    this: *mut c_void,
    address: u64,
    buffer: *mut u8,
    size: u32,
    count: *mut u32,
) -> Hr {
    if count.is_null() {
        return E_INVALIDARG;
    }
    *count = 0;
    if size == 0 {
        return 0;
    }
    let address = if (*(this as *mut Target)).pointer_size == 4 && address >> 32 == 0xffffffff {
        address as u32 as u64
    } else {
        address
    };
    if buffer.is_null()
        || size > 32 * 1024 * 1024
        || address < 0x10000
        || address > usize::MAX as u64
        || address
            .checked_add(size as u64)
            .is_none_or(|end| end > usize::MAX as u64)
    {
        return E_INVALIDARG;
    }
    let mut got = 0;
    ReadProcessMemory(
        (*(this as *mut Target)).handle,
        address as *const c_void,
        buffer.cast(),
        size as usize,
        &mut got,
    );
    *count = got as u32;
    if got > 0 {
        0
    } else {
        E_FAIL
    }
}
unsafe extern "system" fn write(
    _: *mut c_void,
    _: u64,
    _: *const u8,
    _: u32,
    count: *mut u32,
) -> Hr {
    if !count.is_null() {
        *count = 0;
    }
    E_ACCESSDENIED
}
unsafe extern "system" fn get_tls(_: *mut c_void, _: u32, _: u32, out: *mut u64) -> Hr {
    if !out.is_null() {
        *out = 0;
    }
    E_NOTIMPL
}
unsafe extern "system" fn set_tls(_: *mut c_void, _: u32, _: u32, _: u64) -> Hr {
    E_ACCESSDENIED
}
unsafe extern "system" fn current_thread(_: *mut c_void, out: *mut u32) -> Hr {
    if !out.is_null() {
        *out = 0;
    }
    E_NOTIMPL
}
unsafe extern "system" fn get_context(_: *mut c_void, _: u32, _: u32, _: u32, _: *mut u8) -> Hr {
    E_NOTIMPL
}
unsafe extern "system" fn set_context(_: *mut c_void, _: u32, _: u32, _: *const u8) -> Hr {
    E_ACCESSDENIED
}
unsafe extern "system" fn request(
    _: *mut c_void,
    _: u32,
    _: u32,
    _: *const u8,
    _: u32,
    _: *mut u8,
) -> Hr {
    E_NOTIMPL
}
static VTABLE: TargetVtable = TargetVtable {
    query,
    add_ref,
    release,
    machine,
    pointer_size,
    image_base,
    read,
    write,
    get_tls,
    set_tls,
    current_thread,
    get_context,
    set_context,
    request,
};

/// Load only the target runtime's Microsoft-signed DAC. Trust is evaluated
/// without showing dialogs or fetching certificates in the sampling loop.
pub fn verify_dac(path: &Path) -> Result<std::fs::File, String> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    // Keep a read-only handle that denies writes/replacement until LoadLibrary
    // has mapped the exact file whose signature was checked.
    let locked = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(path)
        .map_err(|e| format!("Open DAC: {e}"))?;
    use windows_sys::Win32::Security::{Cryptography::*, WinTrust::*};
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut file: WINTRUST_FILE_INFO = zeroed();
        file.cbStruct = size_of::<WINTRUST_FILE_INFO>() as u32;
        file.pcwszFilePath = path.as_ptr();
        file.hFile = locked.as_raw_handle();
        let mut data: WINTRUST_DATA = zeroed();
        data.cbStruct = size_of::<WINTRUST_DATA>() as u32;
        data.dwUIChoice = WTD_UI_NONE;
        data.dwUnionChoice = WTD_CHOICE_FILE;
        data.Anonymous.pFile = &mut file;
        data.dwStateAction = WTD_STATEACTION_VERIFY;
        data.dwProvFlags =
            WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE | WTD_DISABLE_MD2_MD4;
        let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
        let status = WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
        let valid = (|| {
            if status != 0 {
                return Err(format!(
                    "DAC Authenticode verification failed: 0x{:08X}",
                    status as u32
                ));
            }
            let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
            if provider.is_null() {
                return Err("DAC signer unavailable".into());
            }
            let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
            if signer.is_null() {
                return Err("DAC signer unavailable".into());
            }
            let cert = WTHelperGetProvCertFromChain(signer, 0);
            if cert.is_null() || (*cert).pCert.is_null() {
                return Err("DAC signer certificate unavailable".into());
            }
            let mut name = [0u16; 512];
            let size = CertGetNameStringW(
                (*cert).pCert,
                CERT_NAME_ATTR_TYPE,
                0,
                szOID_ORGANIZATION_NAME.cast(),
                name.as_mut_ptr(),
                name.len() as u32,
            );
            if size < 2 || size > name.len() as u32 || wide(&name) != "Microsoft Corporation" {
                return Err("DAC must be signed by Microsoft Corporation".into());
            }
            Ok(())
        })();
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        WinVerifyTrust(
            null_mut(),
            &mut action,
            (&mut data as *mut WINTRUST_DATA).cast(),
        );
        valid.map(|()| locked)
    }
}
