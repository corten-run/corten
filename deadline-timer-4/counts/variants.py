#!/usr/bin/env python3
"""Rewrites a tree's crates/corten/src/deadline.rs (the head's) into a candidate form, or the
benchmark entry's main.rs to take two more settings from the environment.

    python3 variants.py <tree> out1|out8|far|soon|entry

out1, out8  the connection's timer is taken out of the wheel at the end of a poll of the
            connection when it is set and no deadline has taken it in the last 1 (8) polls that
            began and ended with it at home
far         the connection's timer is moved to its far time when a deadline gives it back, and
            moved to the deadline's time when one takes it
soon        a deadline sets the connection's timer no later than 1 s from now, and sets it again
            each time it fires before the deadline's own time
entry       ARENA_DEADLINE_MS (the app's deadline) and ARENA_STANDING_MS (a task of the serving
            runtime that sleeps that long, again and again)
"""

import sys


def swap(text, old, new, count=1):
    if text.count(old) != count:
        raise SystemExit(f"expected {count} of: {old!r}, found {text.count(old)}")
    return text.replace(old, new)


def out(text, polls):
    text = swap(
        text,
        "struct Held(Pin<Box<Sleep>>);",
        "struct Held {\n"
        "    timer: Pin<Box<Sleep>>,\n"
        "    /// Whether the timer has been set since it was made or last taken out of the wheel.\n"
        "    set: bool,\n"
        "    /// Polls of the connection that ended with the timer at home, set, since a deadline last took it.\n"
        "    idle: u8,\n"
        "}\n\n"
        f"/// The polls after which a set timer no deadline has taken is taken out of the wheel.\n"
        f"const OUT: u8 = {polls};\n\n"
        "impl Held {\n"
        "    /// Takes the timer out of the wheel: a new one in its place, and the old one's drop takes\n"
        "    /// the lock once.\n"
        "    #[cold]\n"
        "    fn out(&mut self) {\n"
        "        if let Ok(new) = std::panic::catch_unwind(|| tokio::time::sleep(Duration::MAX)) {\n"
        "            self.timer.set(new);\n"
        "            self.set = false;\n"
        "            self.idle = 0;\n"
        "        }\n"
        "    }\n"
        "}\n\n"
        "/// At the end of a poll of a connection that has made its timer.\n"
        "#[inline]\n"
        "fn unused() {\n"
        "    let _ = TIMER.try_with(|home| {\n"
        "        if let Some(mut held) = home.take() {\n"
        "            if held.set {\n"
        "                held.idle += 1;\n"
        "                if held.idle > OUT {\n"
        "                    held.out();\n"
        "                }\n"
        "            }\n"
        "            home.set(Some(held));\n"
        "        }\n"
        "    });\n"
        "}",
    )
    text = swap(text, "timer.0.deadline()", "timer.timer.deadline()")
    text = swap(
        text,
        "        let polled = this.conn.poll(cx);\n",
        "        let polled = this.conn.poll(cx);\n        if polling.mine.id > ASKED {\n            unused();\n        }\n",
    )
    text = swap(text, ".ok().map(Held);", ".ok().map(|timer| Held { timer, set: false, idle: 0 });")
    text = swap(
        text,
        "        timer.0.as_mut().reset(after(limit));\n",
        "        timer.timer.as_mut().reset(after(limit));\n        timer.set = true;\n        timer.idle = 0;\n",
    )
    text = swap(text, '.expect("there until dropped").0.as_mut().poll(cx)', '.expect("there until dropped").timer.as_mut().poll(cx)')
    return text


def far(text):
    text = swap(text, "struct Held(Pin<Box<Sleep>>);", "struct Held(Pin<Box<Sleep>>, Instant);")
    text = swap(
        text,
        ".ok().map(Held);",
        ".ok().map(|timer| {\n        let far = timer.deadline();\n        Held(timer, far)\n    });",
    )
    text = swap(
        text,
        "        if BY.try_with(Cell::get) == Ok(self.of) {\n",
        "        if BY.try_with(Cell::get) == Ok(self.of) {\n"
        "            if let Some(timer) = &mut self.timer {\n"
        "                let far = timer.1;\n"
        "                timer.0.as_mut().reset(far);\n"
        "            }\n",
    )
    return text


def soon(text):
    text = swap(
        text,
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);",
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);\n\n"
        "/// The furthest ahead a deadline sets its connection's timer: a timer left set by a\n"
        "/// connection that goes idle is out of the wheel no later than this.\n"
        "const SOON: Duration = Duration::from_secs(1);",
    )
    text = swap(text, "pub(crate) struct Kept {\n    of: u64,\n", "pub(crate) struct Kept {\n    of: u64,\n    /// The deadline's own time.\n    until: Instant,\n")
    text = swap(
        text,
        "        timer.0.as_mut().reset(after(limit));\n",
        "        let now = Instant::now();\n"
        "        let until = now + limit.min(Duration::from_secs(86400 * 365 * 30));\n"
        "        timer.0.as_mut().reset(until.min(now + SOON));\n",
    )
    text = swap(text, "        Some(Kept { of, timer: Some(timer) })\n", "        Some(Kept { of, until, timer: Some(timer) })\n")
    text = swap(
        text,
        '            Waiting::Kept { kept } => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(cx),\n',
        "            Waiting::Kept { kept } => {\n"
        "                let until = kept.until;\n"
        '                let timer = &mut kept.timer.as_mut().expect("there until dropped").0;\n'
        "                loop {\n"
        "                    if timer.as_mut().poll(cx).is_pending() {\n"
        "                        return Poll::Pending;\n"
        "                    }\n"
        "                    let now = Instant::now();\n"
        "                    if now >= until {\n"
        "                        return Poll::Ready(());\n"
        "                    }\n"
        "                    timer.as_mut().reset(until.min(now + SOON));\n"
        "                }\n"
        "            }\n",
    )
    text = swap(
        text,
        "/// `limit` from now, and no further off than 30 years, the longest `tokio::time::sleep` waits.\n"
        "fn after(limit: Duration) -> Instant {\n"
        "    Instant::now() + limit.min(Duration::from_secs(86400 * 365 * 30))\n"
        "}\n",
        "",
    )
    return text


def req(text, requests):
    """Out of the wheel after `requests` requests of the connection in a row that ended without
    having waited (page.rs tells the thread when one does: see page())."""
    text = swap(
        text,
        "struct Held(Pin<Box<Sleep>>);",
        "struct Held {\n"
        "    timer: Pin<Box<Sleep>>,\n"
        "    /// Whether the timer has been set since it was made or last taken out of the wheel.\n"
        "    set: bool,\n"
        "    /// Requests of the connection that ended without having waited since a deadline last took it.\n"
        "    idle: u8,\n"
        "}\n\n"
        f"/// The requests in a row that do not wait after which a set timer is taken out of the wheel.\n"
        f"const OUT: u8 = {requests};\n\n"
        "impl Held {\n"
        "    /// A request of the connection ended without having waited.\n"
        "    #[inline]\n"
        "    fn unwaited(&mut self) {\n"
        "        if self.set {\n"
        "            self.idle += 1;\n"
        "            if self.idle >= OUT {\n"
        "                self.out();\n"
        "            }\n"
        "        }\n"
        "    }\n\n"
        "    /// Takes the timer out of the wheel: a new one in its place, and the old one's drop takes\n"
        "    /// the lock once.\n"
        "    #[cold]\n"
        "    fn out(&mut self) {\n"
        "        if std::thread::panicking() {\n"
        "            return;\n"
        "        }\n"
        "        if let Ok(new) = std::panic::catch_unwind(|| tokio::time::sleep(Duration::MAX)) {\n"
        "            self.timer.set(new);\n"
        "            self.set = false;\n"
        "            self.idle = 0;\n"
        "        }\n"
        "    }\n"
        "}",
    )
    text = swap(
        text,
        "    static TIMER: Cell<Option<Held>> = const { Cell::new(None) };\n}",
        "    static TIMER: Cell<Option<Held>> = const { Cell::new(None) };\n"
        "    /// Whether a request of the connection being polled, which has made its timer, ended in\n"
        "    /// this poll without having waited.\n"
        "    static IDLE: Cell<bool> = const { Cell::new(false) };\n}",
    )
    text = swap(
        text,
        "        if BY.replace(self.by) > ASKED {\n            swap(&mut self.mine.timer);\n        }\n",
        "        if BY.replace(self.by) > ASKED {\n"
        "            swap(&mut self.mine.timer);\n"
        "            if IDLE.replace(false) {\n"
        "                if let Some(held) = &mut self.mine.timer {\n"
        "                    held.unwaited();\n"
        "                }\n"
        "            }\n"
        "        }\n",
    )
    text = swap(text, "timer.0.deadline()", "timer.timer.deadline()")
    text = swap(text, ".ok().map(Held);", ".ok().map(|timer| Held { timer, set: false, idle: 0 });")
    text = swap(
        text,
        "        timer.0.as_mut().reset(after(limit));\n",
        "        timer.timer.as_mut().reset(after(limit));\n        timer.set = true;\n        timer.idle = 0;\n",
    )
    text = swap(text, '.expect("there until dropped").0.as_mut().poll(cx)', '.expect("there until dropped").timer.as_mut().poll(cx)')
    text = swap(
        text,
        "    /// Ready once `limit` has passed since the first call.\n",
        "    /// Tells the connection being polled, if it has made its timer, that a request of its has\n"
        "    /// ended without having waited.\n"
        "    #[inline]\n"
        "    pub(crate) fn ended(&self) {\n"
        "        if matches!(self, Timer::Unset) && BY.get() > ASKED {\n"
        "            IDLE.set(true);\n"
        "        }\n"
        "    }\n\n"
        "    /// Ready once `limit` has passed since the first call.\n",
    )
    return text


def rq(text, requests):
    """req again, written so that a poll of a connection costs what it did: the timer stays one
    word, what happened in a poll is two bits on the thread, and the connection reads them in a
    function of its own only when one is set."""
    text = swap(
        text,
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);",
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);\n\n"
        f"/// The requests in a row that do not wait after which a set timer is taken out of the wheel.\n"
        f"const OUT: u8 = {requests};\n"
        "/// In [`MARK`]: a deadline took the timer in this poll.\n"
        "const TOOK: u8 = 1;\n"
        "/// In [`MARK`]: a request ended in this poll without having waited.\n"
        "const ENDED: u8 = 2;\n\n"
        "/// What a poll of a connection that has made its timer saw, read when the poll ends.\n"
        "#[cold]\n"
        "#[inline(never)]\n"
        "fn marked(mine: &mut Mine) {\n"
        "    let mark = MARK.replace(0);\n"
        "    if mark & TOOK != 0 {\n"
        "        mine.idle = 1;\n"
        "    } else if mine.idle != 0 {\n"
        "        if mine.idle < OUT {\n"
        "            mine.idle += 1;\n"
        "        } else if let Some(held) = &mut mine.timer {\n"
        "            // A new timer in the old one's place: the old one's drop takes it out of the\n"
        "            // wheel, under the lock, once.\n"
        "            if !std::thread::panicking() {\n"
        "                if let Ok(new) = std::panic::catch_unwind(|| tokio::time::sleep(Duration::MAX)) {\n"
        "                    held.0.set(new);\n"
        "                    mine.idle = 0;\n"
        "                }\n"
        "            }\n"
        "        }\n"
        "    }\n"
        "}",
    )
    text = swap(
        text,
        "    static TIMER: Cell<Option<Held>> = const { Cell::new(None) };\n}",
        "    static TIMER: Cell<Option<Held>> = const { Cell::new(None) };\n"
        "    /// What has happened in this poll of a connection that has made its timer.\n"
        "    static MARK: Cell<u8> = const { Cell::new(0) };\n}",
    )
    text = swap(
        text,
        "    timer: Option<Held>,\n}\n\nimpl<C> Keeps<C> {",
        "    timer: Option<Held>,\n"
        "    /// 0 while the timer is not known to be set; else one more than the requests that have\n"
        "    /// ended without having waited since a deadline last took it.\n"
        "    idle: u8,\n}\n\nimpl<C> Keeps<C> {",
    )
    text = swap(text, "Keeps { conn, mine: Mine { id: UNNAMED, timer: None } }", "Keeps { conn, mine: Mine { id: UNNAMED, timer: None, idle: 0 } }")
    text = swap(text, "        return Mine { id: WAITED, timer: None };", "        return Mine { id: WAITED, timer: None, idle: 0 };")
    text = swap(text, "    Mine { id: NAMES.fetch_add(1, Relaxed), timer }", "    Mine { id: NAMES.fetch_add(1, Relaxed), timer, idle: 0 }")
    text = swap(
        text,
        "        if BY.replace(self.by) > ASKED {\n            swap(&mut self.mine.timer);\n        }\n",
        "        if BY.replace(self.by) > ASKED {\n"
        "            swap(&mut self.mine.timer);\n"
        "            if MARK.get() != 0 {\n"
        "                marked(self.mine);\n"
        "            }\n"
        "        }\n",
    )
    text = swap(
        text,
        "        timer.0.as_mut().reset(after(limit));\n",
        "        timer.0.as_mut().reset(after(limit));\n        MARK.set(MARK.get() | TOOK);\n",
    )
    text = swap(
        text,
        "    /// Ready once `limit` has passed since the first call.\n",
        "    /// Tells the connection being polled, if it has made its timer, that a request of its has\n"
        "    /// ended without having waited.\n"
        "    #[inline]\n"
        "    pub(crate) fn ended(&self) {\n"
        "        if matches!(self, Timer::Unset) && BY.get() > ASKED {\n"
        "            MARK.set(MARK.get() | ENDED);\n"
        "        }\n"
        "    }\n\n"
        "    /// Ready once `limit` has passed since the first call.\n",
    )
    return text


def page(text):
    """page.rs for req: the deadline's wrapper tells its timer when the handler has answered."""
    text = swap(
        text,
        "        if let Poll::Ready(out) = fut.as_mut().poll(cx) {\n            return Poll::Ready(Ok(out));\n        }\n",
        "        if let Poll::Ready(out) = fut.as_mut().poll(cx) {\n            timer.ended();\n            return Poll::Ready(Ok(out));\n        }\n",
    )
    text = swap(
        text,
        "                if res.extensions().get::<crate::layout::Pending>().is_none() {\n                    return Poll::Ready(Ok(res));\n                }\n",
        "                if res.extensions().get::<crate::layout::Pending>().is_none() {\n                    timer.ended();\n                    return Poll::Ready(Ok(res));\n                }\n",
    )
    text = swap(
        text,
        "            if let Poll::Ready(res) = fill.as_mut().poll(cx) {\n                return Poll::Ready(Ok(res));\n            }\n",
        "            if let Poll::Ready(res) = fill.as_mut().poll(cx) {\n                timer.ended();\n                return Poll::Ready(Ok(res));\n            }\n",
    )
    return text


def soon2(text, millis):
    """A deadline sets the connection's timer no later than `millis` from now. One that waits
    longer sets it once more, to its own time, and takes it out of the wheel when it gives it
    back, so a timer left set by a connection that goes idle fires within `millis`."""
    text = swap(
        text,
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);",
        "/// A connection's timer.\nstruct Held(Pin<Box<Sleep>>);\n\n"
        "/// The furthest ahead a deadline first sets its connection's timer: a timer left set by a\n"
        "/// connection that goes idle is out of the wheel no later than this.\n"
        f"const SOON: Duration = Duration::from_millis({millis});\n\n"
        "impl Held {\n"
        "    /// Takes the timer out of the wheel: a new one in its place, and the old one's drop takes\n"
        "    /// the lock once.\n"
        "    #[cold]\n"
        "    fn out(&mut self) {\n"
        "        if std::thread::panicking() {\n"
        "            return;\n"
        "        }\n"
        "        if let Ok(new) = std::panic::catch_unwind(|| tokio::time::sleep(Duration::MAX)) {\n"
        "            self.0.set(new);\n"
        "        }\n"
        "    }\n"
        "}",
    )
    text = swap(
        text,
        "pub(crate) struct Kept {\n    of: u64,\n",
        "pub(crate) struct Kept {\n    of: u64,\n    /// The deadline's own time.\n    until: Instant,\n"
        "    /// Whether the timer has been set a second time, to that time.\n    again: bool,\n",
    )
    text = swap(
        text,
        "        timer.0.as_mut().reset(after(limit));\n",
        "        let now = Instant::now();\n"
        "        let until = now + limit.min(Duration::from_secs(86400 * 365 * 30));\n"
        "        timer.0.as_mut().reset(until.min(now + SOON));\n",
    )
    text = swap(text, "        Some(Kept { of, timer: Some(timer) })\n", "        Some(Kept { of, until, again: false, timer: Some(timer) })\n")
    text = swap(
        text,
        "        if BY.try_with(Cell::get) == Ok(self.of) {\n",
        "        if BY.try_with(Cell::get) == Ok(self.of) {\n"
        "            if self.again {\n"
        "                if let Some(timer) = &mut self.timer {\n"
        "                    timer.out();\n"
        "                }\n"
        "            }\n",
    )
    text = swap(
        text,
        '            Waiting::Kept { kept } => kept.timer.as_mut().expect("there until dropped").0.as_mut().poll(cx),\n',
        "            Waiting::Kept { kept } => {\n"
        '                let timer = &mut kept.timer.as_mut().expect("there until dropped").0;\n'
        "                if timer.as_mut().poll(cx).is_pending() {\n"
        "                    return Poll::Pending;\n"
        "                }\n"
        "                if kept.again || Instant::now() >= kept.until {\n"
        "                    return Poll::Ready(());\n"
        "                }\n"
        "                kept.again = true;\n"
        "                timer.as_mut().reset(kept.until);\n"
        "                timer.as_mut().poll(cx)\n"
        "            }\n",
    )
    text = swap(
        text,
        "/// `limit` from now, and no further off than 30 years, the longest `tokio::time::sleep` waits.\n"
        "fn after(limit: Duration) -> Instant {\n"
        "    Instant::now() + limit.min(Duration::from_secs(86400 * 365 * 30))\n"
        "}\n",
        "",
    )
    return text


def entry(text):
    text = swap(
        text,
        '    if std::env::var("ARENA_DEADLINE").as_deref() == Ok("off") {\n        return app.deadline(None);\n    }\n',
        '    if std::env::var("ARENA_DEADLINE").as_deref() == Ok("off") {\n        return app.deadline(None);\n    }\n'
        '    if let Some(ms) = number("ARENA_DEADLINE_MS") {\n        return app.deadline(Duration::from_millis(ms as u64));\n    }\n',
    )
    text = swap(
        text,
        "    let plain = corten::serve_on(listeners(8080, each, shared)?, app());\n",
        '    if let Some(ms) = number("ARENA_STANDING_MS") {\n'
        "        tokio::spawn(async move {\n"
        "            loop {\n"
        "                tokio::time::sleep(Duration::from_millis(ms as u64)).await;\n"
        "            }\n"
        "        });\n"
        "    }\n"
        "    let plain = corten::serve_on(listeners(8080, each, shared)?, app());\n",
    )
    return text


def main():
    tree, which = sys.argv[1], sys.argv[2]
    forms = {
        "out1": lambda t: out(t, 1),
        "out8": lambda t: out(t, 8),
        "far": far,
        "soon": soon,
        "entry": entry,
        "req1": lambda t: req(t, 1),
        "req8": lambda t: req(t, 8),
        "soon2": lambda t: soon2(t, 1000),
        "soon2h": lambda t: soon2(t, 100),
        "rq1": lambda t: rq(t, 1),
        "rq8": lambda t: rq(t, 8),
    }
    path = tree + ("/bench/httparena/corten/src/main.rs" if which == "entry" else "/crates/corten/src/deadline.rs")
    with open(path, encoding="utf-8", newline="") as file:
        text = file.read()
    with open(path, "w", encoding="utf-8", newline="") as file:
        file.write(forms[which](text))
    if which in ("req1", "req8", "rq1", "rq8"):
        path = tree + "/crates/corten/src/page.rs"
        with open(path, encoding="utf-8", newline="") as file:
            text = file.read()
        with open(path, "w", encoding="utf-8", newline="") as file:
            file.write(page(text))


if __name__ == "__main__":
    main()
