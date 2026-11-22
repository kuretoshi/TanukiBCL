use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
const REQUIRED: [&str; 4] = [
    "msvcp140.dll",
    "msvcp140_1.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
];
fn has_files(directories: &[PathBuf], is_file: impl Fn(&Path) -> bool) -> bool {
    REQUIRED.iter().all(|dll| {
        directories
            .iter()
            .any(|directory| is_file(&directory.join(dll)))
    })
}
pub fn installed(runtime: &Path, refresh: bool) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let mut directories = vec![runtime.to_owned()];
    if let Some(windows) = std::env::var_os("SystemRoot").or_else(|| std::env::var_os("WINDIR")) {
        let system = if cfg!(target_pointer_width = "32")
            && std::env::var_os("PROCESSOR_ARCHITEW6432").is_some()
        {
            "Sysnative"
        } else {
            "System32"
        };
        directories.push(PathBuf::from(windows).join(system));
    }
    type Cached = Option<(Vec<PathBuf>, Instant, bool)>;
    static CACHE: OnceLock<Mutex<Cached>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if !refresh {
        if let Some((paths, checked, value)) = cache.as_ref() {
            if paths == &directories && checked.elapsed() < Duration::from_secs(5) {
                return *value;
            }
        }
    }
    // File checks only: do not load runtime DLLs or recognition models here.
    let value = has_files(&directories, Path::is_file);
    *cache = Some((directories, Instant::now(), value));
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_partial_system_and_app_local_runtime() {
        let paths = vec![PathBuf::from("runtime"), PathBuf::from("System32")];
        assert!(!has_files(&paths, |_| false));
        assert!(!has_files(&paths, |p| p.file_name().unwrap() != "msvcp140_1.dll"));
        assert!(has_files(&paths, |p| p.starts_with("System32")));
        assert!(has_files(&paths, |p| p.starts_with("runtime")));
    }
}
