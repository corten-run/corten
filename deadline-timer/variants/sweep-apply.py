"""Runs on a host, in a tree that has v1.patch applied: turns it into measurement variant V3."""
import shutil
import sys

tree, here = sys.argv[1], sys.argv[2]
shutil.copy(f"{here}/v3-deadline.rs", f"{tree}/crates/corten/src/deadline.rs")


def edit(path, pairs):
    text = open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert text.count(old) == 1, (path, text.count(old), old[:70])
        text = text.replace(old, new)
    open(path, "w", encoding="utf-8").write(text)


edit(
    f"{tree}/crates/corten/src/watch.rs",
    [
        (
            "const STALLED: u64 = u64::MAX;\n",
            "const STALLED: u64 = u64::MAX;\n/// A request whose deadline has passed (`Watch::due`).\nconst LATE: u64 = u64::MAX;\n",
        ),
        ("    timeout: u64,\n    send: u64,\n", "    timeout: u64,\n    send: u64,\n    tick: u64,\n"),
        (
            "            send: millis(send),\n            watches",
            "            send: millis(send),\n            tick: tick.as_millis() as u64,\n            watches",
        ),
        (
            "            held: AtomicBool::new(false),\n            clock: self.clone(),",
            "            held: AtomicBool::new(false),\n            due: AtomicU64::new(0),\n            late: AtomicWaker::new(),\n            clock: self.clone(),",
        ),
        (
            "            // `stalled` is one past the time the write found the socket full.\n",
            "            let due = watch.due.load(Relaxed);\n"
            "            if due != 0 && due != LATE && now >= due - 1 && watch.due.compare_exchange(due, LATE, Relaxed, Relaxed).is_ok() {\n"
            "                watch.late.wake();\n"
            "            }\n"
            "            // `stalled` is one past the time the write found the socket full.\n",
        ),
        (
            "    held: AtomicBool,\n    clock: Arc<Clock>,\n}\n",
            "    held: AtomicBool,\n    /// 0, [`LATE`], or one past the time the request's deadline passes.\n    due: AtomicU64,\n    late: AtomicWaker,\n    clock: Arc<Clock>,\n}\n",
        ),
        (
            "    fn expired(&self) -> bool {\n",
            "    /// The request being answered is late `limit` from now: the clock's time is as of its\n"
            "    /// last tick, so a tick more, never early.\n"
            "    pub(crate) fn due_in(&self, limit: Duration) {\n"
            "        let limit = u64::try_from(limit.as_millis()).unwrap_or(u64::MAX / 4).min(u64::MAX / 4);\n"
            "        self.due.store(self.clock.now.load(Relaxed) + limit + self.clock.tick + 1, Relaxed);\n"
            "    }\n\n"
            "    pub(crate) fn not_due(&self) {\n"
            "        self.due.store(0, Relaxed);\n"
            "    }\n\n"
            "    pub(crate) fn poll_late(&self, cx: &mut Context<'_>) -> Poll<()> {\n"
            "        if self.due.load(Relaxed) == LATE {\n"
            "            return Poll::Ready(());\n"
            "        }\n"
            "        self.late.register(cx.waker());\n"
            "        if self.due.load(Relaxed) == LATE {\n"
            "            return Poll::Ready(());\n"
            "        }\n"
            "        Poll::Pending\n"
            "    }\n\n"
            "    fn expired(&self) -> bool {\n",
        ),
    ],
)
edit(
    f"{tree}/crates/corten/src/app.rs",
    [
        (
            "crate::watch::Watched { io, watch, _open: permit });",
            "crate::watch::Watched { io, watch: watch.clone(), _open: permit });",
        ),
        (
            "crate::deadline::Keeps::new(http.serve_connection(io, service).with_upgrades())",
            "crate::deadline::Keeps::with(http.serve_connection(io, service).with_upgrades(), watch)",
        ),
    ],
)
print("v3 applied")
