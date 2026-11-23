
// 1846w's probe, appended by build.sh to a copy of the tree (wait-src-<side>), never to src-<side>.
#[cfg(all(test, feature = "compress", feature = "json"))]
#[path = "probe_wait.rs"]
mod probe_wait;
