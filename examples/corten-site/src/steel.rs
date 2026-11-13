//! The third layer: the server. Its own readings streamed live, the response this page was sent,
//! read back with the defaults `App` puts around every route in it, the same address answering
//! as JSON, and the one file it all is.
use corten::prelude::*;

use crate::{
    Here, Msg, layout,
    looks::{Built, Slab},
    url,
    works::{Machine, Pulse, percent},
    world::{Layer, Opening},
};

/// The headers this page is answered with, and what each is there for. All but the last are
/// `App`'s defaults (`docs/guide/app.md`); the values are read back from the response itself.
pub(crate) const HEADERS: [(&str, &str); 9] = [
    (
        "content-security-policy",
        "No inline script or style runs, and scripts load from this origin alone. Trusted Types guard what a script may write into the page.",
    ),
    ("cache-control", "One reader's page is never handed to another. A handler says so when an answer is for everyone."),
    ("etag", "A reload of a page that has not changed is answered 304, with no body."),
    ("content-encoding", "zstd, Brotli or gzip, whichever your browser asked for. One feature turns it on."),
    ("vary", "The page, a patch of it and its JSON share this address, and a cache keeps them apart."),
    ("x-content-type-options", "A file is what the server says it is, never what it looks like."),
    ("cross-origin-opener-policy", "A window another site opens gets no handle on this one."),
    ("permissions-policy", "Camera, microphone, location and the rest stay off until the app asks for one."),
    ("server-timing", "This site's own: a short middleware times each request, and the strip at the bottom reads it back."),
];

#[component(css)]
pub fn Steel<'a>(here: Here<'a>, pulse: &'a Pulse, binary_bytes: u64, machine: &'a Machine, t: Msg) -> impl Render {
    html! {
        <Opening
            layer={Layer::Steel}
            place="Layer 3 of 3"
            name="Steel"
            claim="Rust underneath, and one server for every surface."
        />
        <div class={Live}>
            <div class={Slab {}}>
                <h3>"Live data is patches"</h3>
                <p>
                    "These are this server's readings, streamed as HTML. The runtime swaps each in by its id, with no script of this page's own. The page timed is this one, 1,000 wall tiles in each render: heavier than the item page the certificate measures."
                </p>
                <p>
                    "Open this page in a second tab and the count of pages following goes up in both. Close it and the stream's signal aborts on the server, and the count comes back down. A stream carries a cursor, so a reconnect resumes where it left off."
                </p>
                if machine.metered {
                    <p>
                        if machine.held() {
                            "The last two readings are counted by the operating system each second: the CPU and memory in use, of the machine or of the limit this server is held to, as each says."
                        } else {
                            "The last two readings are the whole machine's, counted by its operating system each second: the CPU and memory in use by everything on it."
                        }
                    </p>
                }
                <Built on={&["Server-sent events", "Last-Event-ID", "AbortSignal"][..]} />
            </div>
            <corten-live src={url::Readings} since={pulse.beat}><Readout pulse={pulse} machine={machine} /></corten-live>
        </div>
        <div class={Sent}>
            <div class={Slab {}}>
                <h3>"Production defaults, in the response you are reading"</h3>
                <p>
                    "These are the headers this server answers this page with, read from a second request made as you reached here. An app is "
                    <code>"App::new(routes)"</code> " and " <code>"corten::serve"</code>
                    ", and these come with it, except where a note says otherwise."
                </p>
                <p>
                    "Asked for JSON, the same address answers with this page's data, so a native screen or an agent reads what a person sees. With the Cargo feature "
                    <code>"agent"</code> ", agents can also be given an app's actions as Model Context Protocol tools."
                </p>
                <p>
                    "Not in a header: a form another site posts is refused before its handler runs, "
                    <code>"/health/live"</code> " and " <code>"/health/ready"</code>
                    " answer a load balancer, a shutdown lets open requests finish and ends streams first, and every failure is answered in the app's own layout."
                </p>
                <Built on={&["HTTP caching", "Content negotiation", "CSP and Trusted Types", "Fetch Metadata"][..]} />
            </div>
            <Answer here={here} t={t} />
        </div>
        <div class={Binary}>
            <p class={Weight}>
                if binary_bytes > 0 {
                    {megabytes(binary_bytes)}
                    " MiB"
                } else {
                    "One file"
                }
            </p>
            <div class={Slab {}}>
                <h3>"One binary"</h3>
                <p>
                    "That is the whole site: server, runtime, scripts, styles and images, compiled into one program. A Corten app has no JavaScript build step, and "
                    <code>"static/"</code> " ships inside the binary."
                </p>
                <Host machine={machine} />
            </div>
        </div>
    }
}

/// What the server has to work with, by the system's count, and what whoever runs it calls it:
/// the machine, and then what the server is held to (`Machine::held_cpus`, and a limit of
/// memory less than the machine's), each of the CPUs and the memory on its own, since a
/// container or a unit may limit one and not the other. It points at the gauges only where
/// they are of the CPUs the server may use, and is not drawn where the system counts neither.
#[component]
fn Host<'a>(machine: &'a Machine) -> impl Render {
    let (held_cpus, held_memory) = (machine.held_cpus().map(cpus), machine.memory_limited.then_some(machine.memory_bytes));
    html! {
        if machine.whole_bytes > 0 && machine.machine_cpus() > 0 {
            <p>
                "The machine serving you this has " {cpus(machine.machine_cpus() as f64)} " and "
                {megabytes(machine.whole_bytes)} " MiB of memory, by the system's count"
                for named in machine.named.iter() {
                    ": " {named.as_str()}
                }
                "."
                if held_cpus.is_some() || held_memory.is_some() {
                    " This server is held to "
                    for count in held_cpus.iter() {
                        {count.as_str()}
                    }
                    if held_cpus.is_some() && held_memory.is_some() {
                        " and "
                    }
                    for bytes in held_memory.iter() {
                        {megabytes(*bytes)}
                        " MiB of memory"
                    }
                    "."
                }
                if machine.counts_its_cpus() {
                    " The readings above say how much of each is in use."
                }
            </p>
        }
    }
}

/// A size in mebibytes with one decimal, as text: 6291456 is `6.0`, and 16 GiB `16,384.0`.
fn megabytes(bytes: u64) -> String {
    let tenths = bytes.saturating_mul(10).saturating_add(524_288) / 1_048_576;
    format!("{}.{}", counted(tenths / 10), tenths % 10)
}

/// A count with its thousands apart, as text: 1234567 is `1,234,567`. The readout is drawn once
/// for every reader by the task that takes the reading, outside any request, so it has no
/// reader's locale to write a number in (`t.number`): it is written one way for all.
fn counted(n: u64) -> String {
    let digits = n.to_string();
    let mut text = String::with_capacity(digits.len() + digits.len() / 3);
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at).is_multiple_of(3) {
            text.push(',');
        }
        text.push(digit);
    }
    text
}

/// How long the server has been up, as a clock: `1:02:03`, or `2:03` in its first hour.
fn clock(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if hours > 0 { format!("{hours}:{minutes:02}:{seconds:02}") } else { format!("{minutes}:{seconds:02}") }
}

/// The readout's id: each fragment of the stream replaces the element that has it.
#[derive(Id)]
pub struct ReadoutId;

/// The labels of the last two gauges: each one's meter is named by its label.
#[derive(Id)]
pub struct CpuUsedId;

#[derive(Id)]
pub struct MemoryUsedId;

/// A limit as a count of CPUs, as text, to the hundredth and never none: `1 CPU`,
/// `0.5 CPU`, `1.5 CPUs`.
fn cpus(limit: f64) -> String {
    let hundredths = ((limit * 100.0).round() as u64).max(1);
    let count = format!("{}.{:02}", hundredths / 100, hundredths % 100);
    let count = count.trim_end_matches('0').trim_end_matches('.');
    format!("{count} {}", if hundredths > 100 { "CPUs" } else { "CPU" })
}

/// The server's readings. Drawn by the page, then by every fragment `/live/works` streams; a
/// number that moved since the last reading is drawn hot, and cools. The last two say how much
/// is in use of what the server has to work with, each with a meter, and are drawn where the
/// system counts both (`Machine::metered`): the machine's, or, where its control group holds the
/// server to a limit, what is in use of that limit, and each gauge says which. A figure is
/// sized to its gauge by how much it holds, so a count in the millions fits a third of a row.
#[component(css)]
pub fn Readout<'a>(pulse: &'a Pulse, machine: &'a Machine) -> impl Render {
    let used = pulse.used;
    let (up, pages, followers, plates) =
        (clock(pulse.beat), counted(pulse.pages), counted(pulse.followers), counted(pulse.plates));
    // No memory in use is a reading not yet taken.
    let memory = percent(used.memory_bytes, machine.memory_bytes).filter(|_| used.memory_bytes > 0);
    let (render, held) = (counted(pulse.render_micros), megabytes(pulse.held_bytes));
    let in_use = megabytes(used.memory_bytes);
    // The size a figure of so many characters is drawn at; a unit after it takes the room of two.
    let fit = |figure: &str, unit: usize| match figure.len() + unit {
        0..=6 => None,
        7..=8 => Some(Long),
        9..=11 => Some(Longer),
        _ => Some(Longest),
    };
    html! {
        <dl id={ReadoutId} class={Readout}>
            <div class={Gauge}>
                <dt>"Up for"</dt>
                <dd class={(Figure, fit(&up, 0))}>{up.as_str()}</dd>
            </div>
            <div class={Gauge}>
                <dt>"Pages rendered"</dt>
                <dd class={(Figure, fit(&pages, 0), pulse.moved.pages.then_some(Hot))}>{pages.as_str()}</dd>
                <dd class={Note}>{counted(pulse.pages_a_second)} " a second"</dd>
            </div>
            <div class={Gauge}>
                <dt>"Last page rendered in"</dt>
                if pulse.render_micros > 0 {
                    <dd class={(Figure, fit(&render, 2), pulse.moved.render.then_some(Hot))}>
                        {render.as_str()}
                        <span class={Unit}>" µs"</span>
                    </dd>
                } else {
                    <dd class={(Figure, Long)}>"none yet"</dd>
                }
            </div>
            <div class={Gauge}>
                <dt>"Pages following this stream"</dt>
                <dd class={(Figure, fit(&followers, 0), pulse.moved.followers.then_some(Hot))}>{followers.as_str()}</dd>
                <dd class={Note}>{counted(pulse.most_followers)} " at most"</dd>
            </div>
            <div class={Gauge}>
                <dt>"Plates struck"</dt>
                <dd class={(Figure, fit(&plates, 0), pulse.moved.plates.then_some(Hot))}>{plates.as_str()}</dd>
            </div>
            if pulse.held_bytes > 0 {
                <div class={Gauge}>
                    <dt>"Memory this server holds"</dt>
                    <dd class={(Figure, fit(&held, 2))}>{held.as_str()} <span class={Unit}>" MiB"</span></dd>
                </div>
            }
            if machine.metered {
                // A meter is white-hot above its `high`: little is left. The CPU is counted
                // between two readings, so the first has none yet.
                <div class={(Gauge, Wide)}>
                    <dt id={CpuUsedId}>
                        if machine.cpu_limit.is_some() {
                            "CPU in use"
                        } else {
                            "CPU this machine is using"
                        }
                    </dt>
                    match used.cpu {
                        Some(cpu) => {
                            <dd class={Figure}>{cpu} <span class={Unit}>"%"</span></dd>
                            <dd>
                                <meter
                                    class={Bar}
                                    aria-labelledby={CpuUsedId}
                                    aria-valuetext={machine.cpu_limit.map(|limit| format!("{cpu}% of a limit of {}", cpus(limit)))}
                                    min="0"
                                    max="100"
                                    high="80"
                                    value={cpu}
                                >
                                    {cpu} "%"
                                </meter>
                            </dd>
                        }
                        None => <dd class={(Figure, Long)}>"counting"</dd>,
                    }
                    match machine.cpu_limit {
                        Some(limit) => <dd class={Note}>"of a limit of " {cpus(limit)}</dd>,
                        None => {
                            for own in used.cpu_own.iter() {
                                <dd class={Note}>"this server: " {own} "%"</dd>
                            }
                        }
                    }
                </div>
                <div class={(Gauge, Wide)}>
                    <dt id={MemoryUsedId}>
                        if machine.memory_limited {
                            "Memory in use"
                        } else {
                            "Memory this machine is using"
                        }
                    </dt>
                    match memory {
                        Some(memory) => {
                            <dd class={(Figure, fit(&in_use, 2))}>{in_use.as_str()} <span class={Unit}>" MiB"</span></dd>
                            <dd>
                                <meter
                                    class={Bar}
                                    aria-labelledby={MemoryUsedId}
                                    aria-valuetext={format!("{in_use} of {}{} MiB", if machine.memory_limited { "a limit of " } else { "" }, megabytes(machine.memory_bytes))}
                                    min="0"
                                    max="100"
                                    high="80"
                                    value={memory}
                                >
                                    {memory}
                                    "%"
                                </meter>
                            </dd>
                        }
                        None => <dd class={(Figure, Long)}>"counting"</dd>,
                    }
                    <dd class={Note}>
                        "of "
                        if machine.memory_limited {
                            "a limit of "
                        }
                        {megabytes(machine.memory_bytes)}
                        " MiB"
                    </dd>
                </div>
            }
        </dl>
    }
}

/// What this page's address is answered with, read back from a second request: each header
/// `App` answers with, its value as the reader's browser got it, and what it is there for; then
/// the same address asked for JSON.
/// Only a script can read a response, so the values are written in where one runs (`answer.js`,
/// once the reader reaches this), and the commands that show the same stand where none does.
#[component(css, js)]
pub(crate) fn Answer<'a>(here: Here<'a>, t: Msg) -> impl Render {
    let (status, value, json, said, failed) = refs();
    let (absent, read, answered) = (t.answer_absent(), t.answer_read(), t.js().answer_status());
    let address = layout::origin().unwrap_or("https://the-address-of-this-page");
    html! {
        <div
            class={Answer}
            on:connect={js::read(scope, status, value, json, said, failed, crate::page(), absent, read, answered, signal)}
        >
            <figure class={Asked}>
                <figcaption class={Ask}>
                    <code class={Line}>"GET /"</code>
                    <span>"as your browser asks"</span>
                    <output ref={status} class={Status}></output>
                </figcaption>
                <dl class={Heads}>
                    for (name, note) in HEADERS {
                        <div class={Head}>
                            <dt class={Name}>{name}</dt>
                            <dd ref={value} class={Value} data-header={name}></dd>
                            <dd class={Note}>{note}</dd>
                        </div>
                    }
                </dl>
                if here.bare {
                    <p class={Unread}>
                        "A script writes each header's value in. With this page's scripts blocked, read them yourself: "
                        <code>"curl -sI --compressed " {address} "/"</code>
                    </p>
                } else {
                    <noscript>
                        <p class={Unread}>
                            "A script writes each header's value in. Without one, read them yourself: "
                            <code>"curl -sI --compressed " {address} "/"</code>
                        </p>
                    </noscript>
                }
            </figure>
            <figure class={Asked}>
                <figcaption class={Ask}>
                    <code class={Line}>"GET /"</code>
                    <span>"as an agent asks, with"</span>
                    <code class={Line}>"Accept: application/json"</code>
                </figcaption>
                <pre ref={json} class={Json} tabindex="0" role="region" aria-label="This page as JSON">
                    <code>"curl -H \"Accept: application/json\" " {address} "/"</code>
                </pre>
            </figure>
            // Says that the answers arrived, for a reader who cannot see them appear.
            <p ref={said} class={Said} role="status"></p>
            <p ref={failed} class={Failed} role="alert" hidden>"The server did not answer. Reload the page to ask again."</p>
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_clocks_read_as_written() {
        assert_eq!(megabytes(6_291_456), "6.0");
        assert_eq!(megabytes(7_654_321), "7.3");
        assert_eq!(clock(59), "0:59");
        assert_eq!(clock(3_723), "1:02:03");
        assert_eq!(
            (counted(0), counted(999), counted(1_000), counted(1_234_567)),
            ("0".into(), "999".into(), "1,000".into(), "1,234,567".into())
        );
        assert_eq!(megabytes(16 << 30), "16,384.0");
        assert_eq!(
            (cpus(1.0), cpus(0.5), cpus(1.5), cpus(2.0), cpus(0.25)),
            ("1 CPU".into(), "0.5 CPU".into(), "1.5 CPUs".into(), "2 CPUs".into(), "0.25 CPU".into())
        );
        assert_eq!((cpus(1.004), cpus(1.006), cpus(0.001)), ("1 CPU".into(), "1.01 CPUs".into(), "0.01 CPU".into()));
    }

    const MEMINFO: Option<&str> = Some("MemTotal:         468428 kB\nMemAvailable:     268428 kB\n");

    fn draw(machine: &Machine, pulse: Pulse) -> String {
        Readout { pulse: &pulse, machine }.to_html()
    }

    /// A machine the system counts for, with the limits a control group sets on it.
    fn metered(memory_max: Option<&str>, cpu_max: Option<&str>) -> Machine {
        Machine { metered: true, ..Machine::counted(1, MEMINFO, memory_max, cpu_max) }
    }

    /// The last two gauges are drawn where the system counts, each with a meter of how much is in
    /// use, and say whose count they are: the machine's, with this server's part, or of a limit.
    #[test]
    fn the_last_two_gauges_say_how_much_is_in_use_and_of_what() {
        use crate::works::Used;
        let used = |cpu, cpu_own, memory_bytes| Pulse { used: Used { cpu, cpu_own, memory_bytes }, ..Pulse::default() };
        let whole = draw(&metered(None, None), used(Some(41), Some(31), 200 << 20));
        assert!(whole.contains(r#"<dt id="cpu-used">CPU this machine is using</dt>"#), "{whole}");
        assert!(whole.contains(r#"<dt id="memory-used">Memory this machine is using</dt>"#), "{whole}");
        assert!(whole.contains(r#"aria-labelledby="cpu-used" min="0" max="100" high="80" value="41""#), "{whole}");
        // 200 MiB of 468428 KiB is 44%, and the meter is read as the sizes.
        assert!(whole.contains(r#"aria-valuetext="200.0 of 457.4 MiB" min="0" max="100" high="80" value="44""#), "{whole}");
        assert!(whole.contains("this server: 31%") && whole.contains(">of 457.4 MiB<"), "{whole}");
        assert!(!whole.contains("container") && !whole.contains("limit"), "{whole}");
        // Held to half a CPU and 256 MiB: both counts are of the limit, and say so.
        let held = draw(&metered(Some("268435456\n"), Some("50000 100000\n")), used(Some(85), None, 250 << 20));
        assert!(held.contains(">CPU in use</dt>") && held.contains(">Memory in use</dt>"), "{held}");
        assert!(held.contains(">of a limit of 0.5 CPU<") && held.contains(">of a limit of 256.0 MiB<"), "{held}");
        assert!(held.contains(r#"value="85""#) && held.contains(r#"value="98""#) && !held.contains("this machine"), "{held}");
        // A meter is read as its label and its value, so under a limit the value says of what.
        assert!(held.contains(r#"aria-valuetext="85% of a limit of 0.5 CPU""#), "{held}");
        assert!(held.contains(r#"aria-valuetext="250.0 of a limit of 256.0 MiB""#), "{held}");
        assert_eq!(whole.matches("aria-valuetext").count(), 1, "{whole}");
        // One limit alone changes its own gauge and leaves the other the machine's.
        let memory = draw(&metered(Some("268435456\n"), None), used(Some(41), Some(31), 200 << 20));
        assert!(memory.contains("CPU this machine is using") && memory.contains(">Memory in use</dt>"), "{memory}");
        // The first reading has no CPU yet, and says it is counting; nothing is drawn empty.
        let first = draw(&metered(None, None), used(None, None, 200 << 20));
        assert!(
            first.contains(">counting</dd>") && first.matches("<meter").count() == 1 && !first.contains("this server:"),
            "{first}"
        );
        for drawn in [&whole, &held, &memory, &first, &draw(&metered(None, None), Pulse::default())] {
            assert!(!drawn.contains("<dd></dd>") && !drawn.contains(r#""></dd>"#), "{drawn}");
        }
        // Where the system does not count, neither gauge is drawn, whatever a reading holds.
        let none = draw(&Machine::counted(1, MEMINFO, None, None), used(Some(41), Some(31), 200 << 20));
        assert!(!none.contains("is using") && !none.contains("in use") && !none.contains("<meter"), "{none}");
    }

    /// The page says the machine as the machine's, and what the server is held to as that: the
    /// CPUs and the memory each on its own, and never a limit as a container's alone. It points
    /// at the gauges only where they are of the CPUs the server may use.
    #[test]
    fn the_host_is_said_as_a_machine_and_what_the_server_is_held_to() {
        const MACHINE: &str = "<p>The machine serving you this has ";
        const GAUGES: &str = " The readings above say how much of each is in use.</p>";
        let host = |machine: &Machine| Host { machine }.to_html().replace("&#39;", "'");
        let on = |stat_cpus, memory_max, cpu_max| Machine { stat_cpus, ..metered(memory_max, cpu_max) };
        assert_eq!(host(&on(1, None, None)), format!("{MACHINE}1 CPU and 457.4 MiB of memory, by the system's count.{GAUGES}"));
        // Kept to one CPU of the machine's eight, by no limit of its group's: the gauge is not of that one.
        assert_eq!(
            host(&on(8, None, None)),
            format!("{MACHINE}8 CPUs and 457.4 MiB of memory, by the system's count. This server is held to 1 CPU.</p>")
        );
        let held = Machine { named: Some("the smallest size".into()), ..on(8, Some("268435456\n"), Some("50000 100000\n")) };
        assert_eq!(
            host(&held),
            format!(
                "{MACHINE}8 CPUs and 457.4 MiB of memory, by the system's count: the smallest size. This server is held to 0.5 CPU and 256.0 MiB of memory.{GAUGES}"
            )
        );
        // One limit alone is said alone: the other figure stays the machine's.
        let memory = Machine { cpus: 8, ..on(8, Some("268435456\n"), None) };
        assert_eq!(
            host(&memory),
            format!(
                "{MACHINE}8 CPUs and 457.4 MiB of memory, by the system's count. This server is held to 256.0 MiB of memory.{GAUGES}"
            )
        );
        assert_eq!(
            host(&on(8, None, Some("50000 100000\n"))),
            format!("{MACHINE}8 CPUs and 457.4 MiB of memory, by the system's count. This server is held to 0.5 CPU.{GAUGES}")
        );
        // Where the machine's own count has no CPUs, they are those the server may use; where
        // the system counts neither CPUs nor memory, nothing is said.
        assert!(host(&on(0, None, None)).starts_with(&format!("{MACHINE}1 CPU and 457.4 MiB")));
        assert_eq!((host(&Machine::default()), host(&Machine { cpus: 4, ..Machine::default() })), (String::new(), String::new()));
        assert_eq!(host(&Machine { cpus: 0, ..on(0, None, None) }), "");
        // No count of the server's own is not a count of none: nothing is said of a hold, and
        // the server is taken to have the machine's CPUs, as the page's JSON says it.
        assert_eq!(
            host(&Machine { cpus: 0, ..on(8, None, None) }),
            format!("{MACHINE}8 CPUs and 457.4 MiB of memory, by the system's count.{GAUGES}")
        );
        // A limit of all the machine has is still the group's count, and is said.
        assert!(
            host(&on(1, None, Some("100000 100000\n")))
                .contains("has 1 CPU and 457.4 MiB of memory, by the system's count. This server is held to 1 CPU.")
        );
        assert!(!host(&held).contains("container"));
    }

    /// How many classes the figure that reads `text` has.
    fn classes(drawn: &str, text: &str) -> usize {
        let end = drawn.find(&format!("\">{text}</dd>")).unwrap_or_else(|| panic!("no figure reads {text}: {drawn}"));
        let start = drawn[..end].rfind("class=\"").expect("a figure has a class") + 7;
        drawn[start..end].split(' ').count()
    }

    /// A figure of seven characters or more has a class more, which draws it smaller: a unit
    /// counts for two, and a figure in words is long already.
    #[test]
    fn a_long_figure_is_drawn_smaller() {
        let machine = Machine::default();
        let short = draw(&machine, Pulse { beat: 3_723, pages: 99_999, followers: 4_096, plates: 12, ..Pulse::default() });
        assert_eq!(
            (classes(&short, "1:02:03"), classes(&short, "99,999"), classes(&short, "4,096"), classes(&short, "12")),
            (2, 1, 1, 1)
        );
        assert_eq!(classes(&short, "none yet"), 2);
        let grown = draw(
            &machine,
            Pulse {
                beat: 36_000,
                pages: 100_000,
                followers: 1_000_000,
                plates: 123_456,
                render_micros: 12_345,
                held_bytes: 1 << 30,
                ..Pulse::default()
            },
        );
        assert!(grown.contains(r#"">12,345<span"#) && grown.contains(r#"">1,024.0<span"#), "{grown}");
        assert_eq!(
            (classes(&grown, "10:00:00"), classes(&grown, "100,000"), classes(&grown, "1,000,000"), classes(&grown, "123,456")),
            (2, 2, 2, 2)
        );
    }
}
