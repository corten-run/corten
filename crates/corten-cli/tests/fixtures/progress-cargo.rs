use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

fn main() {
    let command = std::env::args().nth(1).unwrap();
    if command == "metadata" {
        println!("{{\"packages\":[],\"workspace_members\":[]}}");
    } else if command == "test" {
        // Like a cold test build, held until the redirected reader has observed its progress.
        eprintln!("Compiling check-progress-fixture");
        let release = PathBuf::from(std::env::var_os("CHECK_RELEASE").unwrap());
        let start = Instant::now();
        while !release.exists() {
            assert!(start.elapsed() < Duration::from_secs(20), "reader did not release build");
            std::thread::sleep(Duration::from_millis(10));
        }
        println!("test-output");
        if std::env::var_os("CHECK_FAIL_TESTS").is_some() {
            std::process::exit(1);
        }
    }
}
