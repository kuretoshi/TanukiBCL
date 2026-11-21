fn main() {
    let root = std::env::var("TANUKI_SHERPA_ROOT").expect("TANUKI_SHERPA_ROOT is required");
    cc::Build::new()
        .cpp(true)
        .file("engine.cpp")
        .flag_if_supported("/std:c++17")
        .flag_if_supported("/utf-8")
        .flag_if_supported("/EHsc")
        .compile("tanuki_speech");
    println!("cargo:rustc-link-search=native={}/runtime", root);
    println!("cargo:rustc-link-lib=dylib=sherpa-onnx-c-api");
    println!("cargo:rerun-if-changed=engine.cpp");
    println!("cargo:rerun-if-changed=c-api.h");
}
