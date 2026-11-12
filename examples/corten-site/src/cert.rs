//! The measurements, laid out as a mill test certificate: the paper that travels with a plate
//! of steel and says what was measured, how, and on which heat. Every number is from
//! `docs/performance.md` and the README (the tests below hold them to those files), with the
//! commits they were measured at and the conditions. A chart shows every app of its round, the
//! ones ahead of Corten included; what it leaves out of a round, it says.
use corten::prelude::*;

use crate::layout::Static;

/// Where the certificate starts, for the bar's link.
#[derive(Id)]
pub struct CertificateId;

/// The README's table: what was measured, and the result. The page's JSON carries it.
pub const MEASURED: [(&str, &str); 6] = [
    ("Item pages rendered from memory", "20,705 a second, 47 µs of CPU each"),
    ("The same item as JSON", "26,385 a second"),
    ("Memory after the first request", "1.3 MiB"),
    ("JavaScript the item page loaded", "14.1 KB (gzip)"),
    ("Interactive on a throttled phone, on desktop", "468 ms, 59 ms"),
    ("Taking over 1,000 server-rendered rows", "10.2 ms, 101 bytes of memory per row"),
];

/// Round r16 on the server, every app of it, most pages first (`docs/performance.md`, On the
/// server and CPU and memory per request): the app, item pages a second from memory at 64
/// users, the CPU it took to serve 300 pages a second, its memory after the first request and
/// the time from process start to its first page. Each cell is the document's.
const SERVED: [ServedRow; 18] = [
    ("axum 0.8 + Maud 0.27", "27,327", "3.6%", "1.34 MiB", "6.3 ms"),
    ("Corten", "20,705", "4.2%", "1.277 MiB", "8.6 ms"),
    ("Drogon 1.9", "17,870", "4.3%", "3.258 MiB", "31 ms"),
    ("Topcoat 0.11", "5,647", "8.4%", "1.5 MiB", "8.1 ms"),
    ("Gin 1.12", "4,687", "8.5%", "1.941 MiB", "10 ms"),
    ("ASP.NET Core 10", "4,115", "25%", "30.67 MiB", "724 ms"),
    ("Phoenix 1.8", "1,478", "36%", "125.3 MiB", "1.3 s"),
    ("Leptos 0.8", "1,356", "25%", "1.488 MiB", "8.0 ms"),
    ("Astro 7", "1,202", "29%", "36.5 MiB", "319 ms"),
    ("Spring Boot 4.1", "1,023", "51%", "140.8 MiB", "7.5 s"),
    ("SvelteKit 3", "815", "43%", "25.63 MiB", "201 ms"),
    ("TanStack Start", "696", "50%", "27.58 MiB", "237 ms"),
    ("React Router 7", "530", "61%", "33.17 MiB", "357 ms"),
    ("Rails 8.1", "440", "75%", "63.83 MiB", "1.1 s"),
    ("Nuxt 4", "325", "100%, 291/s served", "36.49 MiB", "348 ms"),
    ("Django 6.1", "311", "93%", "65.66 MiB", "1.1 s"),
    ("Next.js 16", "failed (191)", "failed (89%, 159/s served)", "52.58 MiB", "705 ms"),
    ("Laravel 13", "failed", "failed", "96.2 MiB", "863 ms"),
];

/// Time to interactive on the throttled phone, in milliseconds, for the eighteen apps of round
/// r16, fastest first (`docs/performance.md`, In the browser).
const PHONE: [(&str, u32); 18] = [
    ("ASP.NET Core 10", 447),
    ("Drogon 1.9", 450),
    ("Django 6.1", 451),
    ("Topcoat 0.11", 455),
    ("Corten", 468),
    ("Spring Boot 4.1", 642),
    ("axum 0.8 + Maud 0.27", 643),
    ("Gin 1.12", 645),
    ("Astro 7", 683),
    ("Laravel 13", 884),
    ("SvelteKit 3", 887),
    ("Phoenix 1.8", 955),
    ("React Router 7", 1106),
    ("Rails 8.1", 1182),
    ("Next.js 16", 1437),
    ("Nuxt 4", 1563),
    ("Leptos 0.8", 1926),
    ("TanStack Start", 2401),
];

/// The commits the numbers were measured at (`docs/performance.md`): round r16, then browser-4.
const MEASURED_AT: [(&str, &str); 2] = [("eea6adb", "round r16"), ("3fb4b1ac", "round browser-4")];

/// The apps of round browser-4, in its table's order. The last is the floor: hand-written code.
const APPS: [&str; 7] = ["Corten", "Solid 1.9", "Svelte 5", "Vue 3.5", "React 19", "Remix 3", "Plain JS"];

/// A screen the browser changes, round browser-4, every row of the document's table, a result
/// for each of `APPS`. Lower is better in every row.
const CLIENT: [(&str, [&str; 7]); 12] = [
    ("Take over 1,000 server-rendered rows", ["10.2 ms", "16.2 ms", "19.3 ms", "21.6 ms", "54.8 ms", "131 ms", "1.1 ms"]),
    ("First click on a taken-over row", ["1.4 ms", "1.0 ms", "2.4 ms", "2.2 ms", "4.4 ms", "11.7 ms", "0.3 ms"]),
    ("Change 1 row of 10,000", ["0.2 ms", "0.2 ms", "1.0 ms", "2.4 ms", "8.4 ms", "77.8 ms", "0.2 ms"]),
    ("Change 100 rows of 10,000", ["0.5 ms", "0.7 ms", "1.4 ms", "3.2 ms", "7.4 ms", "78.6 ms", "0.4 ms"]),
    ("Update every 10th of 1,000", ["0.6 ms", "0.5 ms", "0.5 ms", "0.8 ms", "1.6 ms", "7.1 ms", "0.3 ms"]),
    ("Select a row", ["0.2 ms", "0.2 ms", "0.6 ms", "0.4 ms", "0.7 ms", "6.8 ms", "0.1 ms"]),
    ("Swap two rows", ["0.3 ms", "0.5 ms", "0.5 ms", "0.5 ms", "7.5 ms", "5.9 ms", "0.2 ms"]),
    ("Create 1,000 rows", ["5.0 ms", "4.4 ms", "5.8 ms", "8.3 ms", "10.5 ms", "11.6 ms", "3.8 ms"]),
    ("Create 10,000 rows", ["48.4 ms", "41.6 ms", "57.7 ms", "85.4 ms", "284 ms", "123 ms", "37.5 ms"]),
    ("Dashboard: 200 prices tick", ["0.4 ms", "0.7 ms", "0.8 ms", "1.0 ms", "0.6 ms", "12.6 ms", "0.3 ms"]),
    ("Memory per row", ["101 B", "928 B", "1,229 B", "1,876 B", "2,031 B", "2,413 B", "166 B"]),
    ("JavaScript, gzip", ["17.9 KB", "6.8 KB", "20.6 KB", "26.2 KB", "68.4 KB", "28.4 KB", "1.1 KB"]),
];

/// The rows of that table the page draws, and what each is called above its bars. Each is
/// drawn for Corten and the four frameworks after it in `APPS`; the certificate says what
/// Remix 3 and the floor did.
const DRAWN: [(&str, &str); 3] = [
    ("Take over 1,000 server-rendered rows", "Taking over 1,000 server-rendered rows"),
    ("Memory per row", "Memory held for each row"),
    ("Dashboard: 200 prices tick", "A dashboard where 200 prices tick"),
];

/// How many of `APPS` a drawn row shows, from the first.
const SHOWN: usize = 5;

/// The floor of round browser-4, the last of `APPS`, and its row for the JavaScript an app ships.
const FLOOR: &str = "Plain JS";
const SHIPPED: &str = "JavaScript, gzip";

/// A column of round r16's three tables in which another app is ahead of Corten
/// (`docs/performance.md`, CPU and memory per request and In the browser): the column as the
/// document heads it, Corten's result and how many apps are ahead of it. These are the columns
/// the certificate has no table for; the tests hold them, and the ones `SERVED` and `PHONE`
/// carry, to every column of the round.
type Trail = (&'static str, &'static str, usize);
const PER_CPU: Trail = ("Pages per CPU-second", "21,195", 1);
const PER_MIB: Trail = ("Pages a second per MiB", "1,234", 2);
const PEAK: Trail = ("Peak memory, 64 users", "16.8 MiB", 4);
const PAINT: Trail = ("Phone: largest paint", "460 ms", 8);
const MOVED: Trail = ("Phone: client navigation", "199 ms", 1);
const DESKTOP: Trail = ("Desktop: interactive", "59 ms", 5);
const SCRIPT: Trail = ("JavaScript, gzip", "14.1 KB", 2);

/// An app ahead in one of those columns that the certificate gives a result for: the column,
/// the app and its result.
type Ahead = (&'static str, &'static str, &'static str);
const AXUM_PER_CPU: Ahead = (PER_CPU.0, "axum 0.8 + Maud 0.27", "28,300");
const AXUM_PER_MIB: Ahead = (PER_MIB.0, "axum 0.8 + Maud 0.27", "1,697");
const DROGON_PER_MIB: Ahead = (PER_MIB.0, "Drogon 1.9", "1,407");
const PHOENIX_MOVED: Ahead = (MOVED.0, "Phoenix 1.8", "138 ms");
const ASTRO_SCRIPT: Ahead = (SCRIPT.0, "Astro 7", "9.2 KB");
const LEPTOS_SCRIPT: Ahead = (SCRIPT.0, "Leptos 0.8", "7.0 KB + 305 KB WASM");

/// A result's number, whatever its unit: `1,229 B` is 1229. `None` where the app failed.
fn amount(result: &str) -> Option<f64> {
    let digits: String = result.chars().take_while(|c| !c.is_whitespace()).filter(|c| *c != ',').collect();
    digits.parse().ok()
}

/// `2401` as the documents write it: `2,401`.
fn grouped(n: u32) -> String {
    if n >= 1000 { format!("{},{:03}", n / 1000, n % 1000) } else { n.to_string() }
}

/// The phone's time for one app of round r16.
fn phone(app: &str) -> String {
    grouped(PHONE.iter().find(|(name, _)| *name == app).map_or(0, |&(_, ms)| ms))
}

/// One app's result in a row of round browser-4, as the document writes it.
fn result(operation: &str, app: &str) -> &'static str {
    let row = CLIENT.iter().find(|(name, _)| *name == operation);
    let at = APPS.iter().position(|name| *name == app);
    row.zip(at).map_or("", |((_, results), at)| results[at])
}

/// A row of `SERVED`: the app, then its four results.
type ServedRow = (&'static str, &'static str, &'static str, &'static str, &'static str);

/// One app's row of round r16 on the server, by the start of its name.
fn served(app: &str) -> ServedRow {
    SERVED.iter().find(|row| row.0.starts_with(app)).copied().unwrap_or(SERVED[0])
}

/// A drawn row's bars: the app, its result, and its share of the longest bar.
fn bars(operation: &str) -> Vec<(&'static str, &'static str, f64)> {
    let Some((_, results)) = CLIENT.iter().find(|(name, _)| *name == operation) else { return Vec::new() };
    let shown = &results[..SHOWN];
    let most = shown.iter().filter_map(|result| amount(result)).fold(0.0, f64::max);
    APPS.iter().zip(shown).map(|(&app, &result)| (app, result, amount(result).unwrap_or(0.0) * 100.0 / most)).collect()
}

#[component(css)]
pub fn Certificate<'a>(req: &'a Req) -> impl Render {
    let most = SERVED.iter().filter_map(|row| amount(row.1)).fold(0.0, f64::max);
    let ours = served("Corten");
    let (axum, leptos, topcoat) = (served("axum"), served("Leptos"), served("Topcoat"));
    let drawn: Vec<_> = DRAWN.iter().map(|&(operation, title)| (title, bars(operation))).collect();
    // Where Corten is among the phone's times, and how far behind the nearest and the soonest.
    let at = PHONE.iter().position(|&(app, _)| app == "Corten").unwrap_or(0);
    let (nearest, soonest) = (PHONE[at].1 - PHONE[at.saturating_sub(1)].1, PHONE[at].1 - PHONE[0].1);
    html! {
        <article id={CertificateId} class={Certificate}>
            <header class={Head}>
                <img src={req.asset(Static::LOCKUP_SVG)} alt="Corten" width="170" height="40" class={Mark}>
                <div>
                    <h2 class={Title}>"Mill test certificate"</h2>
                    <p class={Standard}>
                        "A plate of steel ships with a paper saying what was measured and how. This is Corten's. Its first value is to be fast and proven fast, so each number here has its conditions, and every round's full tables are one link away."
                    </p>
                </div>
                <dl class={Heat}>
                    <div>
                        <dt>"Product"</dt>
                        <dd>"corten-run 0.2"</dd>
                    </div>
                    <div>
                        <dt>"Measured at"</dt>
                        <dd>
                            for (commit, round) in MEASURED_AT {
                                <span class={Tested}>{commit} " (" {round} ")"</span>
                            }
                        </dd>
                    </div>
                    <div>
                        <dt>"This sheet"</dt>
                        <dd>
                            "built from " {crate::HEAT}
                            if crate::DIRTY {
                                ", with changes not yet committed"
                            }
                        </dd>
                    </div>
                    <div>
                        <dt>"Method"</dt>
                        <dd><a href={crate::links::performance()}>"docs/performance.md"</a></dd>
                    </div>
                </dl>
            </header>
            <section class={Part}>
                <h3 class={Heading}>"One round, one CPU, eighteen apps we wrote"</h3>
                <p class={Lede}>
                    "A historical round, not a ranking of frameworks: Corten's maintainers wrote all eighteen apps, none has yet been reviewed in full by its framework's maintainers, and their localization work was not equal. Corten's own row is the claim. On one CPU and 1 GiB, Corten served "
                    <b>{ours.1} " pages a second"</b>
                    ", used "
                    <b>{ours.2} " of the CPU"</b>
                    " to serve 300 a second, held "
                    <b>{ours.3}</b>
                    " after its first request and was serving "
                    <b>{ours.4}</b>
                    " after it started."
                </p>
                <div class={Scroll} tabindex="0" role="region" aria-label="On the server, round r16">
                    <table class={(Results, Served)} aria-label="On the server, round r16">
                        <thead>
                            <tr>
                                <th scope="col">"App"</th>
                                <th scope="col">"Pages a second"</th>
                                <th scope="col">"CPU for 300 a second"</th>
                                <th scope="col">"Memory, first request"</th>
                                <th scope="col">"Start to first page"</th>
                            </tr>
                        </thead>
                        <tbody>
                            for (app, pages, cpu, memory, start) in SERVED {
                                <tr class={(Row, (app == "Corten").then_some(Ours))}>
                                    <th scope="row">{app}</th>
                                    <td>
                                        <div class={Rate}>
                                            <span class={Track}>
                                                <span
                                                    class={Fill}
                                                    style={SHARE.pct(amount(pages).unwrap_or(0.0) * 100.0 / most)}
                                                ></span>
                                            </span>
                                            <span class={Count}>{pages}</span>
                                        </div>
                                    </td>
                                    <td class={Result}>{cpu}</td>
                                    <td class={Result}>{memory}</td>
                                    <td class={Result}>{start}</td>
                                </tr>
                            }
                        </tbody>
                    </table>
                </div>
                <p class={Conditions}>
                    "Conditions. Round r16 (2026-11-06 to 2026-11-07, at eea6adb, one DigitalOcean c-8 droplet, Xeon Platinum 8168): an item page with a listings table, offers and a form that patches, items in memory, 64 users, requests sent uncompressed as curl sends them; a browser's request costs Corten more. Each app was set up the way its framework is run in production. \"Failed\" is an app that could not serve the fixed rate, or start, without tuning."
                </p>
            </section>
            <section class={Part}>
                <h3 class={Heading}>"A screen the browser changes"</h3>
                <p class={Lede}>
                    "Corten sends no framework to the browser, and a screen a script changes is where that is tested: a table of rows, each app written as its js-framework-benchmark entry is. Shorter is better."
                </p>
                <div class={Panels}>
                    for (title, bars) in &drawn {
                        <figure class={Panel}>
                            <figcaption class={Measure}>{*title}</figcaption>
                            <ol class={Bars}>
                                for (app, result, share) in bars {
                                    <li class={(Bar, (*app == "Corten").then_some(Ours))}>
                                        <span class={App}>{*app}</span>
                                        <span class={Track}><span class={Fill} style={SHARE.pct(*share)}></span></span>
                                        <span class={Ms}>{*result}</span>
                                    </li>
                                }
                            </ol>
                        </figure>
                    }
                </div>
                <p class={Phone}>
                    "And on a throttled phone, the item page of round r16 was interactive in "
                    <b>{phone("Corten")} " ms"</b>
                    ". The round's eighteen apps ran from "
                    {grouped(PHONE[0].1)}
                    " ms to "
                    {grouped(PHONE[PHONE.len() - 1].1)}
                    " ms, and "
                    {at}
                    " of them were interactive sooner."
                </p>
                <p class={Conditions}>
                    "Conditions. Round browser-4 (2026-11-11, at 3fb4b1ac, Chromium 156 on Linux, Xeon Platinum 8358). Times run from the click to the DOM being updated, and takeover from the HTML being parsed to the app marking itself ready; memory is what JavaScript holds for each row. The page draws "
                    {DRAWN.len()}
                    " of the round's "
                    {CLIENT.len()}
                    " rows, against "
                    {SHOWN - 1}
                    " of its "
                    {APPS.len() - 2}
                    " frameworks: Remix 3 was behind each of those in every row drawn, and hand-written DOM code, the floor, took "
                    {result(DRAWN[0].0, FLOOR)}
                    " and "
                    {result(DRAWN[2].0, FLOOR)}
                    " and held "
                    {result(DRAWN[1].0, FLOOR)}
                    " a row. The phone is Chromium 148 under the Lighthouse phone profile (4x CPU slowdown, 150 ms round trip, 1.6 Mbps down), median of 10 cold loads."
                </p>
            </section>
            <section class={(Part, Behind)}>
                <h3 class={Heading}>"Where Corten trails"</h3>
                <p class={Lede}>
                    "axum with Maud renders more pages a second, more for each second of CPU ("
                    {AXUM_PER_CPU.2}
                    " against "
                    {PER_CPU.1}
                    "), and took less of a CPU to serve 300 of them a second ("
                    {axum.2}
                    " against "
                    {ours.2}
                    "). It, Leptos and Topcoat served their first page sooner after starting ("
                    {axum.4}
                    ", "
                    {leptos.4}
                    " and "
                    {topcoat.4}
                    " against "
                    {ours.4}
                    "). Under 64 users, "
                    {PEAK.2}
                    " apps held less memory at their peak than Corten's "
                    {PEAK.1}
                    ", and axum and Drogon served more pages a second for each MiB they held ("
                    {AXUM_PER_MIB.2}
                    " and "
                    {DROGON_PER_MIB.2}
                    " against "
                    {PER_MIB.1}
                    "). On the phone, "
                    {at}
                    " apps were interactive sooner, by "
                    {nearest}
                    " to "
                    {soonest}
                    " ms, "
                    {PAINT.2}
                    " painted the page's largest element sooner than Corten's "
                    {PAINT.1}
                    ", and Phoenix went from the home page to the item page sooner ("
                    {PHOENIX_MOVED.2}
                    " against "
                    {MOVED.1}
                    "). On a desktop, "
                    {DESKTOP.2}
                    " apps were interactive sooner than Corten's "
                    {DESKTOP.1}
                    ". Astro's item page loaded less JavaScript ("
                    {ASTRO_SCRIPT.2}
                    " against "
                    {SCRIPT.1}
                    "), and so did Leptos's beside its WebAssembly ("
                    {LEPTOS_SCRIPT.2}
                    "). On the screen the browser changes, Solid is faster on the first click after takeover and at creating rows, and ships less JavaScript ("
                    {result(SHIPPED, "Solid 1.9")}
                    " against Corten's "
                    {result(SHIPPED, "Corten")}
                    ": the runtime, its views module and the screen's handlers), and Solid and Svelte are faster at updating every 10th row. Takeover has moved between runs: round browser-2 measured 29.5 ms, and reruns of that step 4.9, 20.7 and 6.3 ms. "
                    <a href={crate::links::performance()}>"Every row of every round, and the method"</a>
                    "."
                </p>
            </section>
        </article>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PERFORMANCE: &str = include_str!("../../../docs/performance.md");
    const README: &str = include_str!("../../../README.md");

    /// The page's own source, without these tests: what a test looks for in it is in the page.
    fn page() -> &'static str {
        include_str!("cert.rs").split_once("#[cfg(test)]").expect("the tests come last").0
    }

    /// Whether Corten is behind a framework in this row. The last column is the floor,
    /// hand-written code, which no framework is expected to beat.
    fn behind(results: &[&str; 7]) -> bool {
        results[1..6].iter().any(|other| amount(other) < amount(results[0]))
    }

    /// A table row's cells, without the bold the document gives Corten's.
    fn cells(line: &str) -> Vec<String> {
        line.trim_matches('|').split('|').map(|cell| cell.trim().replace("**", "")).collect()
    }

    #[test]
    fn the_readmes_table_is_the_readmes() {
        for (what, result) in MEASURED {
            assert!(README.contains(&format!("| {what} | {result} |")), "the README has no row: {what} | {result}");
        }
    }

    /// The document has three tables with a row an app: on the server, CPU and memory, and in
    /// the browser, in that order.
    #[test]
    fn the_server_table_is_the_rounds() {
        let most_first: Vec<f64> = SERVED.iter().filter_map(|row| amount(row.1)).collect();
        assert!(most_first.windows(2).all(|pair| pair[0] >= pair[1]), "most pages first");
        for (app, pages, cpu, memory, start) in SERVED {
            let rows: Vec<Vec<String>> = PERFORMANCE.lines().map(cells).filter(|row| row[0] == app).collect();
            assert_eq!(rows.len(), 3, "{app} has a row in three tables");
            assert_eq!(
                (rows[0][1].as_str(), rows[0][4].as_str(), rows[0][5].as_str()),
                (pages, start, memory),
                "{app}, on the server"
            );
            assert_eq!(rows[1][2], cpu, "{app}, CPU and memory");
        }
    }

    #[test]
    fn the_phone_times_are_the_rounds() {
        for (app, ms) in PHONE {
            let row = if app == "Corten" {
                format!("| **Corten** | **{} ms** |", grouped(ms))
            } else {
                format!("| {app} | {} ms |", grouped(ms))
            };
            assert!(PERFORMANCE.contains(&row), "docs/performance.md has no row: {row}");
        }
        assert!(PHONE.windows(2).all(|pair| pair[0].1 <= pair[1].1), "fastest first");
        // What the certificate says of the phone is counted from these rows: the apps ahead.
        let ours = PHONE.iter().position(|&(app, _)| app == "Corten").expect("Corten is in the round");
        assert_eq!(
            (ours, format!("{} ms", phone("Corten"))),
            (trail("Phone: interactive").2, trail("Phone: interactive").1.to_string())
        );
    }

    #[test]
    fn the_client_table_is_every_row_of_the_rounds() {
        let table: Vec<&str> = PERFORMANCE
            .lines()
            .skip_while(|line| !line.starts_with("| | **Corten (views)** |"))
            .skip(2)
            .take_while(|line| line.starts_with('|'))
            .collect();
        assert_eq!(table.len(), CLIENT.len(), "a row was added to or left out of the document's table");
        for ((operation, [corten, others @ ..]), line) in CLIENT.iter().zip(table) {
            let row = format!("| {operation} | **{corten}** | {} |", others.join(" | "));
            assert_eq!(line, row);
        }
    }

    /// The rows drawn are the round's, Corten leads each, and Remix 3, which they leave out, is
    /// behind every app they show, as the certificate says.
    #[test]
    fn the_rows_drawn_are_as_the_certificate_says() {
        for (operation, _) in DRAWN {
            let (_, results) = CLIENT.iter().find(|(name, _)| *name == operation).expect("a row of the round");
            assert!(!behind(results), "{operation}: Corten trails a framework");
            assert!(results[1..SHOWN].iter().all(|shown| amount(shown) < amount(results[5])), "{operation}: Remix 3");
            assert_eq!(bars(operation).len(), SHOWN);
        }
    }

    /// Every column of the round's three tables in which another app is ahead of Corten, in
    /// the document's order. Four are written out here because the page reads them from
    /// `SERVED` and `PHONE`, which the tests below hold to these.
    const TRAILS: [Trail; 11] = [
        ("Pages/s, no database", "20,705", 1),
        ("Process start to first page", "8.6 ms", 3),
        PER_CPU,
        ("CPU for 300 pages a second", "4.2%", 1),
        PER_MIB,
        PEAK,
        ("Phone: interactive", "468 ms", 4),
        PAINT,
        MOVED,
        DESKTOP,
        SCRIPT,
    ];

    /// Every app ahead that the certificate gives a result for beyond its tables.
    const NAMED: [Ahead; 6] = [AXUM_PER_CPU, AXUM_PER_MIB, DROGON_PER_MIB, PHOENIX_MOVED, ASTRO_SCRIPT, LEPTOS_SCRIPT];

    /// One column of `TRAILS`, which it must be.
    fn trail(column: &str) -> Trail {
        *TRAILS.iter().find(|trail| trail.0 == column).unwrap_or_else(|| panic!("{column} is no column of TRAILS"))
    }

    /// The round's three tables with a row an app, by their first two columns, and for each of
    /// their columns whether more is better or less is.
    const TABLES: [&str; 3] = ["| | Pages/s, no database |", "| | Pages per CPU-second |", "| | Phone: interactive |"];
    const MORE_IS_BETTER: [&str; 5] =
        ["Pages/s, no database", "JSON/s, no database", "Pages/s, item API", "Pages per CPU-second", "Pages a second per MiB"];
    const LESS_IS_BETTER: [&str; 11] = [
        "Process start to first page",
        "Memory after first request",
        "CPU for 300 pages a second",
        "Peak memory, 64 users",
        "Phone: interactive",
        "Phone: largest paint",
        "Phone: client navigation",
        "Desktop: interactive",
        "Desktop: client navigation",
        "JS heap",
        "JavaScript, gzip",
    ];

    /// A cell's measure: its first number and its unit, a time in seconds given in
    /// milliseconds. `None` where the app failed.
    fn measure(cell: &str) -> Option<(f64, &str)> {
        let mut words = cell.split(' ');
        let first = words.next()?.trim_end_matches(',');
        let number: f64 = first.trim_end_matches('%').replace(',', "").parse().ok()?;
        if first.ends_with('%') {
            return Some((number, "%"));
        }
        Some(match words.next() {
            Some("s") => (number * 1000.0, "ms"),
            unit => (number, unit.unwrap_or("")),
        })
    }

    /// One of the round's tables: its column heads, and a row of cells for each app.
    fn table(starts: &str) -> (Vec<String>, Vec<Vec<String>>) {
        let mut lines = PERFORMANCE.lines().skip_while(|line| !line.starts_with(starts));
        let heads = cells(lines.next().unwrap_or_else(|| panic!("docs/performance.md has no table: {starts}")));
        let rows: Vec<Vec<String>> = lines.skip(1).take_while(|line| line.starts_with('|')).map(cells).collect();
        assert_eq!(rows.len(), 18, "every app of the round");
        (heads, rows)
    }

    /// The apps ahead of Corten in one column, and Corten's own cell.
    fn ahead_in(heads: &[String], rows: &[Vec<String>], column: usize) -> (Vec<String>, String) {
        let head = heads[column].as_str();
        let more = MORE_IS_BETTER.contains(&head);
        assert!(more != LESS_IS_BETTER.contains(&head), "{head}: say whether more is better in this column, or less");
        let ours = rows.iter().find(|row| row[0] == "Corten").expect("Corten's row")[column].clone();
        let (mine, unit) = measure(&ours).expect("Corten's result is a number");
        let mut ahead = Vec::new();
        for row in rows {
            let Some((other, its)) = measure(&row[column]) else { continue };
            assert_eq!(its, unit, "{head}: {} is in another unit than Corten's {ours}", row[0]);
            let leads = if more { other > mine } else { other < mine };
            if leads {
                ahead.push(row[0].clone());
            }
        }
        (ahead, ours)
    }

    /// `TRAILS` is every column of the round's three tables where another app is ahead of
    /// Corten, with Corten's result and the number ahead: a result that moves an app ahead
    /// fails here until the certificate says so, and so does a column the document gains, until
    /// it is said which way is better in it.
    #[test]
    fn where_others_lead_is_every_column_of_the_rounds() {
        let mut found = Vec::new();
        for starts in TABLES {
            let (heads, rows) = table(starts);
            for column in 1..heads.len() {
                let (ahead, ours) = ahead_in(&heads, &rows, column);
                if !ahead.is_empty() {
                    found.push((heads[column].clone(), ours, ahead.len()));
                }
            }
        }
        let said: Vec<(String, String, usize)> =
            TRAILS.iter().map(|&(column, ours, ahead)| (column.to_string(), ours.to_string(), ahead)).collect();
        assert_eq!(found, said);
    }

    /// Each result the certificate gives for an app ahead is the document's, and where it names
    /// the apps ahead in a column it names every one.
    #[test]
    fn the_apps_named_ahead_are_the_documents() {
        for starts in TABLES {
            let (heads, rows) = table(starts);
            for column in 1..heads.len() {
                let (ahead, _) = ahead_in(&heads, &rows, column);
                let named: Vec<_> = NAMED.iter().filter(|row| row.0 == heads[column]).collect();
                for (_, app, result) in &named {
                    let row = rows.iter().find(|row| row[0] == *app).unwrap_or_else(|| panic!("no row for {app}"));
                    assert_eq!(row[column], *result, "{app}, {}", heads[column]);
                    assert!(ahead.iter().any(|name| name == app), "{app} is not ahead in {}", heads[column]);
                }
                assert!(named.is_empty() || named.len() == ahead.len(), "{}: {ahead:?} are ahead", heads[column]);
            }
        }
        // Every column of `NAMED` is one of the round's, and one where others lead.
        assert!(NAMED.iter().all(|named| trail(named.0).2 > 0));
        // The paragraph names these by name: they are who is ahead there.
        fn names(column: &str) -> Vec<&'static str> {
            NAMED.iter().filter(|row| row.0 == column).map(|row| row.1).collect()
        }
        assert_eq!(names("Pages a second per MiB"), ["axum 0.8 + Maud 0.27", "Drogon 1.9"]);
        assert_eq!(names("Phone: client navigation"), ["Phoenix 1.8"]);
        assert_eq!(names("JavaScript, gzip"), ["Astro 7", "Leptos 0.8"]);
    }

    #[test]
    fn where_corten_trails_is_what_the_certificate_says() {
        let trailing: Vec<&str> = CLIENT.iter().filter(|(_, results)| behind(results)).map(|&(operation, _)| operation).collect();
        assert_eq!(
            trailing,
            [
                "First click on a taken-over row",
                "Update every 10th of 1,000",
                "Create 1,000 rows",
                "Create 10,000 rows",
                "JavaScript, gzip"
            ]
        );
        assert_eq!(SERVED[0].0, "axum 0.8 + Maud 0.27");
        assert_eq!(SERVED[1].0, "Corten");
        // On the server, the apps named are every one that took less CPU for the same pages or
        // served its first page sooner, and none held less memory after its first request.
        let ours = served("Corten");
        // `TRAILS` writes Corten's result out in three columns the page reads from this row.
        assert_eq!(
            (trail("Pages/s, no database").1, trail("CPU for 300 pages a second").1, trail("Process start to first page").1),
            (ours.1, ours.2, ours.4)
        );
        let percent = |cell: &str| cell.split_once('%').and_then(|(share, _)| share.parse::<f64>().ok());
        let millis = |cell: &str| {
            let (number, unit) = cell.split_once(' ')?;
            Some(number.parse::<f64>().ok()? * if unit == "s" { 1000.0 } else { 1.0 })
        };
        fn ahead(better: impl Fn(&ServedRow) -> bool) -> Vec<&'static str> {
            SERVED.iter().filter(|row| better(row)).map(|row| row.0).collect()
        }
        assert_eq!(ahead(|row| percent(row.2).is_some_and(|share| Some(share) < percent(ours.2))), [served("axum").0]);
        assert_eq!(
            ahead(|row| millis(row.4).is_some_and(|start| Some(start) < millis(ours.4))),
            [served("axum").0, served("Topcoat").0, served("Leptos").0]
        );
        // The sentence gives the three start times from the soonest.
        assert!(
            millis(served("axum").4) < millis(served("Leptos").4) && millis(served("Leptos").4) < millis(served("Topcoat").4)
        );
        assert!(ahead(|row| amount(row.3).is_some_and(|held| Some(held) < amount(ours.3))).is_empty());
        // What the far side says of axum is these two rows.
        let against = format!("{} against Corten's {}", SERVED[0].1, SERVED[1].1);
        assert!(include_str!("after.rs").contains(&against), "after.rs does not say {against}");
    }

    /// What the conditions count: the rows drawn of the round's, against how many of its
    /// frameworks, and the floor's results and the JavaScript shipped, which the text draws.
    #[test]
    fn the_conditions_count_what_is_drawn() {
        // Corten and the floor are not frameworks it is drawn against.
        assert_eq!((DRAWN.len(), CLIENT.len(), SHOWN - 1, APPS.len() - 2), (3, 12, 4, 5));
        assert_eq!(APPS.last(), Some(&FLOOR));
        assert_eq!(
            [result(DRAWN[0].0, FLOOR), result(DRAWN[2].0, FLOOR), result(DRAWN[1].0, FLOOR)],
            ["1.1 ms", "0.3 ms", "166 B"]
        );
        assert_eq!((result(SHIPPED, "Solid 1.9"), result(SHIPPED, "Corten")), ("6.8 KB", "17.9 KB"));
        assert_eq!(SERVED.len(), 18);
        assert!(page().contains("One round, one CPU, eighteen apps we wrote"));
    }
}
