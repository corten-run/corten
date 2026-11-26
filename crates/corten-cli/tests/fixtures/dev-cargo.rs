//! Stands in for Cargo and for the app under `corten dev`: `build` names this program as the
//! package's binary, and run as that binary it writes the `PORT` it was given to `DEV_PORT_OUT`.
fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("metadata") => println!("{{\"packages\":[],\"workspace_members\":[]}}"),
        Some("build") => {
            let exe = std::env::current_exe().unwrap().display().to_string().replace('\\', "/");
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
