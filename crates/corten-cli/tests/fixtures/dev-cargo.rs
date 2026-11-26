//! Stands in for Cargo and for the app under `corten dev`: `build` names this program as the
//! package's binary, and run as that binary it writes the `PORT` it was given to `DEV_PORT_OUT`.
//! Run at all, it makes the file `DEV_CARGO_RAN` names.
fn main() {
    // Noted for a test that requires Cargo never ran.
    if let Some(ran) = std::env::var_os("DEV_CARGO_RAN") {
        std::fs::write(ran, "").unwrap();
    }
    match std::env::args().nth(1).as_deref() {
        Some("metadata") => println!("{{\"packages\":[],\"workspace_members\":[]}}"),
        Some("build") => {
            // The path as a JSON string, as Cargo writes it.
            let mut exe = String::new();
            for c in std::env::current_exe().unwrap().to_str().unwrap().chars() {
                match c {
                    '"' | '\\' => exe.extend(['\\', c]),
                    c if c < ' ' => exe.push_str(&format!("\\u{:04x}", c as u32)),
                    c => exe.push(c),
                }
            }
            println!("{{\"reason\":\"compiler-artifact\",\"target\":{{\"kind\":[\"bin\"]}},\"executable\":\"{exe}\"}}");
        }
        _ => {
            // Written whole under another name, then renamed, so a reader never sees part of it.
            let out = std::path::PathBuf::from(std::env::var_os("DEV_PORT_OUT").unwrap());
            let part = out.with_extension("part");
            std::fs::write(&part, std::env::var("PORT").unwrap_or_default()).unwrap();
            std::fs::rename(part, out).unwrap();
        }
    }
}
