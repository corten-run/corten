// The probe bench/request-cost counts: two apps with Corten's defaults, one configuration each.
//
// Usage: <bin> <port> <api|pages>
//   api, an app with an API and no pages:
//     GET, POST /baseline11  typed query parameters in (and a number in the body), a short String out
//     GET /unstaged11        the same answer from a route that says `unstaged`, which reads no body
//     GET /pipeline          a route that says `unstaged`, a short str out
//   pages, an app without an API:
//     GET /page              a page of about 12 KB
//     GET /text              a short str out
// PROBE_ALLOCATOR=jemalloc (or glibc) makes the probe refuse to start unless /proc/self/maps shows
// that allocator.
use corten::prelude::*;

#[corten::routes(api = Root)]
mod url {
    #[route("/")]
    pub struct Root;

    #[route("/baseline11", get = crate::baseline, post = crate::baseline)]
    pub struct Baseline {
        pub a: Option<i64>,
        pub b: Option<i64>,
    }

    #[route("/unstaged11", get = crate::baseline_unstaged, unstaged)]
    pub struct BaselineUnstaged {
        pub a: Option<i64>,
        pub b: Option<i64>,
    }

    #[route("/pipeline", get = crate::pipeline, unstaged)]
    pub struct Pipeline;
}

#[corten::routes]
mod pages {
    #[route("/page", get = crate::page)]
    pub struct Page;

    #[route("/text", get = crate::text)]
    pub struct Text;
}

/// The sum of the query values, plus the number in the body when there is one.
async fn baseline(Params(at): Params<url::Baseline>, body: String) -> String {
    let number = body.trim().parse::<i64>().unwrap_or(0);
    (at.a.unwrap_or(0) + at.b.unwrap_or(0) + number).to_string()
}

/// The sum of the query values. Not `baseline` on another route: a handler of a route that says
/// `unstaged` cannot take the body, so this one differs from it by the stages and by reading one.
async fn baseline_unstaged(Params(at): Params<url::BaselineUnstaged>) -> String {
    (at.a.unwrap_or(0) + at.b.unwrap_or(0)).to_string()
}

async fn pipeline() -> &'static str {
    "ok"
}

#[component]
fn Layout(req: &Req, title: &str, children: impl Render) -> impl Document {
    html! {
        <!DOCTYPE html>
        <html lang={req.lang()}>
            <head>
                <meta charset="utf-8">
                <title>{title}</title>
                <Corten />
            </head>
            <body><main>{children}</main></body>
        </html>
    }
}

async fn page(req: Req) -> HtmlResult {
    req.page(html! {
        <Layout req={&req} title="Items">
            <h1>"Items"</h1>
            <table>
                for n in 0..120u32 {
                    <tr>
                        <td>{n}</td>
                        <td>"A row of the page, about as long as a row of a listing is"</td>
                        <td>{n * 7}</td>
                    </tr>
                }
            </table>
        </Layout>
    })
}

async fn text() -> &'static str {
    "ok"
}

/// Refuses to start unless the allocator PROBE_ALLOCATOR names is the one in use.
fn check_allocator() -> Result<(), Box<dyn std::error::Error>> {
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap_or_default();
    let found = if maps.contains("libjemalloc") { "jemalloc" } else { "glibc" };
    eprintln!("ALLOCATOR {found}");
    match std::env::var("PROBE_ALLOCATOR") {
        Ok(asked) if asked != found => Err(format!("PROBE_ALLOCATOR={asked}, but the allocator is {found}").into()),
        _ => Ok(()),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let usage = "usage: <port> <api|pages>";
    let port: u16 = args.get(1).ok_or(usage)?.parse()?;
    let app = match args.get(2).map(String::as_str) {
        Some("api") => App::new(Routes::new()).api(url::api),
        Some("pages") => App::new(pages::router()),
        _ => return Err(usage.into()),
    };
    check_allocator()?;
    // A queue as long as Linux allows by default: idle.mjs opens connections faster than one
    // runtime accepts them, and a connection the queue has no room for waits a second to retry.
    let socket = tokio::net::TcpSocket::new_v4()?;
    socket.set_reuseaddr(true)?;
    socket.bind(([127, 0, 0, 1], port).into())?;
    let listener = socket.listen(4096)?;
    eprintln!("READY {} on {port}", args[2]);
    corten::serve_on(vec![listener], app).await?;
    Ok(())
}
