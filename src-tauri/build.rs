fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_none()
    {
        panic!("Production UI requires the custom-protocol feature. Build with: tauri build --features custom-protocol");
    }
    tauri_build::build()
}
