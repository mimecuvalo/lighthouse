fn main() {
    // ONNX Runtime's prebuilt static lib uses `@available`, which needs `___isPlatformVersionAtLeast`
    // from clang's runtime; rustc links with -nodefaultlibs so it isn't pulled in on its own.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let dir = std::process::Command::new("clang")
            .arg("--print-runtime-dir")
            .output()
            .expect("clang is needed to locate libclang_rt.osx.a");
        let dir = String::from_utf8(dir.stdout).unwrap();
        println!("cargo:rustc-link-search=native={}", dir.trim());
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    }
    tauri_build::build()
}
