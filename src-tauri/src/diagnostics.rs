use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Record the whole app tree, including WebView2 and reader helpers. Bounded logs
/// let a reported growth be attributed to a process without a debugger attached.
pub fn start(directory: PathBuf, running: Arc<AtomicBool>) {
    #[cfg(windows)]
    std::thread::spawn(move || {
        use std::{
            fs::{self, OpenOptions},
            io::Write,
        };
        let path = directory.join("memory.jsonl");
        while running.load(Ordering::Relaxed) {
            if let Ok(processes) = sample() {
                if fs::metadata(&path).is_ok_and(|info| info.len() > 1024 * 1024) {
                    let previous = directory.join("memory.previous.jsonl");
                    let _ = fs::remove_file(&previous);
                    let _ = fs::rename(&path, previous);
                }
                if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
                    let private: u64 = processes.iter().map(|p| p.private_bytes).sum();
                    let working: u64 = processes.iter().map(|p| p.working_set_bytes).sum();
                    let _ = writeln!(
                        file,
                        "{}",
                        serde_json::json!({
                            "unixSeconds": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(),
                            "version": env!("CARGO_PKG_VERSION"), "privateBytes": private,
                            "workingSetBytes": working, "processes": processes,
                        })
                    );
                }
            }
            for _ in 0..30 {
                if !running.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    });
    #[cfg(not(windows))]
    let _ = (directory, running);
}

#[cfg(windows)]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    pid: u32,
    parent_pid: u32,
    name: String,
    private_bytes: u64,
    working_set_bytes: u64,
}

#[cfg(windows)]
fn sample() -> std::io::Result<Vec<Usage>> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{Diagnostics::ToolHelp::*, ProcessStatus::*, Threading::*},
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut entries = Vec::new();
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            entries.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..length]),
            ));
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        let ids = descendants(
            std::process::id(),
            &entries
                .iter()
                .map(|(pid, parent, _)| (*pid, *parent))
                .collect::<Vec<_>>(),
        );
        let mut result = Vec::new();
        for (pid, parent_pid, name) in entries {
            if !ids.contains(&pid) {
                continue;
            }
            let handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid);
            if handle.is_null() {
                continue;
            }
            let mut memory: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            let size = std::mem::size_of_val(&memory) as u32;
            memory.cb = size;
            if GetProcessMemoryInfo(
                handle,
                &mut memory as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                size,
            ) != 0
            {
                result.push(Usage {
                    pid,
                    parent_pid,
                    name,
                    private_bytes: memory.PrivateUsage as u64,
                    working_set_bytes: memory.WorkingSetSize as u64,
                });
            }
            CloseHandle(handle);
        }
        Ok(result)
    }
}

#[cfg(any(windows, test))]
fn descendants(root: u32, entries: &[(u32, u32)]) -> std::collections::HashSet<u32> {
    let mut ids = std::collections::HashSet::from([root]);
    loop {
        let before = ids.len();
        for (pid, parent) in entries {
            if ids.contains(parent) {
                ids.insert(*pid);
            }
        }
        if before == ids.len() {
            return ids;
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn includes_nested_helpers_but_excludes_other_apps() {
        assert_eq!(
            super::descendants(100, &[(300, 200), (2, 1), (200, 100), (400, 300)]),
            std::collections::HashSet::from([100, 200, 300, 400])
        );
    }
}
