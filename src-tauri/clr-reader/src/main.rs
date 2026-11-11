#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod abi;
#[cfg(windows)]
mod managed;
#[cfg(windows)]
mod metadata;
#[cfg(windows)]
mod nos;
#[cfg(windows)]
mod runtime;
#[cfg(windows)]
mod snr;
#[cfg(windows)]
mod target;
#[cfg(windows)]
mod toh;

#[cfg(windows)]
fn run() -> Result<serde_json::Value, String> {
    use serde_json::json;
    let args: Vec<_> = std::env::args().collect();
    let pid: u32 = args
        .get(1)
        .ok_or("PID required")?
        .parse()
        .map_err(|_| "Invalid PID")?;
    let runtime = runtime::Runtime::attach(pid)?;
    if args.get(2).is_some_and(|s| s == "--push-watch") {
        snr::watch(
            &runtime,
            pid,
            args.get(3)
                .map(|s| s.parse().map_err(|_| "Invalid parent PID"))
                .transpose()?,
        )?;
        return Ok(serde_json::Value::Null);
    }
    runtime.flush()?;
    let managed = managed::Managed::new(&runtime);
    if args.get(2).is_some_and(|s| s == "--snr") {
        return snr::basic_layout(&managed, pid);
    }
    if args.get(2).is_some_and(|s| s == "--nos-layout") {
        return nos::layout(&managed, pid);
    }
    if args.get(2).is_some_and(|s| s == "--nos-palette") {
        return nos::palette(&managed, pid);
    }
    if args.get(2).is_some_and(|s| s == "--nos-roles") {
        return nos::roles(&managed, pid);
    }
    if args.get(2).is_some_and(|s| s == "--toh") {
        return toh::layout(&managed, pid);
    }
    let mut modules = Vec::new();
    for module in managed.modules()? {
        if args.get(2).is_some_and(|name| {
            !module
                .name
                .to_ascii_lowercase()
                .ends_with(&name.to_ascii_lowercase())
        }) {
            continue;
        }
        let mut types = Vec::new();
        for ty in runtime.types(module.address)? {
            let fields: Vec<_> = managed.fields(ty.address)?.into_iter().map(|f| json!({"name":f.name,"token": f.data.token, "element": f.data.element, "type": f.data.field_type, "owner": f.data.owner, "offset": f.data.offset, "static": f.data.is_static != 0,"slot": if f.data.is_static!=0 {managed.static_slot(&f).ok().flatten()} else {None}})).collect();
            types.push(json!({"type": ty, "collectible": runtime.collectible(ty.address)?, "fields": fields}));
        }
        modules.push(json!({"module": module, "types": types, "statics": format!("{:?}", runtime.domain_local(module.address))}));
    }
    let handles = runtime.handles()?;
    Ok(
        json!({"status":"ok", "pid":pid, "pointerSize":runtime.target().pointer_size, "modules":modules, "handles":handles.len()}),
    )
}
fn main() {
    #[cfg(windows)]
    let result = run();
    #[cfg(not(windows))]
    let result: Result<serde_json::Value, String> = Err("Windows CLR reader required".into());
    match result {
        Ok(value) => {
            if !value.is_null() {
                println!("{value}");
            }
        }
        Err(error) => {
            println!("{}", serde_json::json!({"status":"error", "message":error}));
            std::process::exit(1);
        }
    }
}
