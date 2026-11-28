//! The watchlist screen: the stocks watched, their prices kept current from a feed, the last
//! trade streamed in, and the form that adds and removes stocks.
use corten::{
    ClientZone, LiveResponse, LiveSince,
    feed::{FeedResponse, Since},
    i18n::Minor,
    prelude::*,
};

use crate::{
    account::Viewer,
    app::{Msg, url},
    layout::Layout,
    lists::{Lists, Watching},
    market::{Market, Stock, USD},
    theme::*,
};

/// The stocks feed: a snapshot, then live changes from a cursor.
pub(crate) async fn stocks(State(market): State<Market>) -> FeedResponse<Stock> {
    market.stocks.snapshot()
}

pub(crate) async fn stocks_live(State(market): State<Market>, since: Since) -> FeedResponse<Stock> {
    market.stocks.live(since)
}

/// The last trade as each one happens, for `<corten-live src>`: every item is a fragment the
/// runtime swaps in by `id`, like a form's patch, with the trade count as its cursor. The page
/// says which trade it shows (`since`), and a reconnect which one it last got, so the first
/// fragment is only sent when the browser is behind; otherwise the stream waits for the next.
pub(crate) async fn trades(State(market): State<Market>, since: LiveSince) -> LiveResponse {
    corten::live_watch(market.trades.subscribe(), since, |(n, _)| *n, |(_, text)| LastTrade { text }.to_html())
}

/// The watchlist screen's data: what the view shows, and what a data client gets.
#[derive(ToJson)]
struct Home {
    /// The stocks watched, in the order they were added.
    stocks: Vec<Stock>,
    last_trade: String,
    /// The trade count `last_trade` is at, where the page's live stream starts from.
    #[serde(skip)]
    trades_seen: u64,
    /// The stocks not watched, by name, as `(ticker, name)`: the watch form's choices.
    #[serde(skip)]
    others: Vec<(&'static str, &'static str)>,
    message: String,
    /// The visitor's picks, when the address asks for them read in (`url::Home { picks }`);
    /// otherwise the page draws them waiting and the runtime reads them from the same route.
    #[serde(skip_serializing_if = "Option::is_none")]
    picks: Option<Vec<Stock>>,
}

impl Home {
    fn new(market: &Market, watching: &Watching, message: String, picks: Option<Vec<Stock>>) -> Self {
        let stocks = market.stocks.read(|rows| watching.ids.iter().filter_map(|id| rows.get(*id).cloned()).collect());
        let others = Market::listed().filter(|(id, _)| !watching.has(id)).collect();
        let (trades_seen, last_trade) = market.trades.borrow().clone();
        Home { stocks, last_trade, trades_seen, others, message, picks }
    }
}

/// The watchlist, with the notice a change of the list left for it when it sent a browser without
/// JavaScript back here (`req.notice()`).
fn home_view<'a>(home: &'a Home, t: Msg, notice: Option<&'a Notice>) -> impl Render {
    html! {
        <div class={(stack(Space::_1), mb_5())}>
            <h1>"Watchlist"</h1>
            <p class={muted()}>
                "Prices and today's change arrive as trades happen. Without JavaScript the page still shows them."
            </p>
        </div>
        <div
            class={(display_grid(), columns(Responsive::new(Columns::_1).md(Columns::Main)), gap_5(), items_start())}
        >
            <section class={card()}>
                <LivePrices stocks={&home.stocks} t={t} />
            </section>
            <aside class={stack(Space::_5)}>
                <div class={(card(), stack(Space::_3))}>
                    <WatchForm others={&home.others} />
                    <div aria-live="polite"><WatchMessage message={&home.message} notice={notice} /></div>
                </div>
                <section class={(card(), stack(Space::_2))}>
                    <h2>"Market activity"</h2>
                    <corten-live src={url::Trades} since={home.trades_seen} aria-live="polite">
                        <LastTrade text={&home.last_trade} />
                    </corten-live>
                </section>
                <section class={(card(), stack(Space::_2))}>
                    <h2>"Picks for you"</h2>
                    match &home.picks {
                        Some(picks) => <PicksList picks={picks} />,
                        None => <PicksLoading />,
                    }
                </section>
            </aside>
        </div>
    }
}

/// The watched stocks with their prices and today's change, rendered here first and then kept
/// current by `live_prices.js` from the stocks feed (`url::Stocks`, a route, so not any text). The pause button shows only when the script runs,
/// since nothing updates without it. The script counts the updates to the stocks shown, with a
/// message of the page's locale (`t.js()`), and writes each price and change with the page's
/// money and change formats, so the text a script computes is the server's. Each row's Remove
/// button submits the watch form (`form={WatchFormId}`) to `/unwatch`, so every change to the
/// list is one form's submit, and the runtime keeps only the newest answer. A change replaces
/// the component, whose new rows subscribe again (a snapshot, then the stream); it starts
/// unpaused, and a removed row's button takes focus with it (the message says what changed).
/// `p` pauses and resumes too, wherever focus is on the page (`on:document:keydown`), unless
/// the key is something else's (`shortcut` in `live_prices.js`).
/// The cells print the text the market wrote when the price moved (`Stock::price`,
/// `Stock::change`), in the app's one locale. Styled by `live_prices.css`.
#[component(css, js)]
pub(crate) fn LivePrices<'a>(stocks: &'a [Stock], t: Msg) -> impl Patch {
    let (pause, price, change, updates) = refs();
    let (updated, money, percent) = (t.js().prices_updates(), t.js().money(USD), t.js().change(2));
    let moved = t.js().signed_money(USD);
    let f = UnwatchForm::FIELDS;
    html! {
        <div
            id={PricesId}
            class={stack(Space::_3)}
            on:connect={js::watch(scope, pause, price, change, money, moved, percent, url::Stocks, signal, updates, updated)}
        >
            <div class={(row(Space::_3), justify_between())}>
                <h2>"Your stocks"</h2>
                <button
                    ref={pause}
                    type="button"
                    aria-pressed="false"
                    aria-keyshortcuts="p"
                    hidden
                    on:click={js::pause(target, price, change)}
                    on:document:keydown={js::pauseKey(event, target, price, change)}
                >
                    "Pause updates"
                </button>
            </div>
            <table class={Table}>
                <thead>
                    <tr>
                        <th>"Stock"</th>
                        <th>"Price"</th>
                        <th>"Today"</th>
                        <th><span class={VisuallyHidden}>"Remove"</span></th>
                    </tr>
                </thead>
                <tbody>
                    for stock in stocks {
                        <tr>
                            <td>
                                <span class={Name}>{stock.name}</span>
                                <span class={Ticker}>{stock.id}</span>
                            </td>
                            <td ref={price} class={Amount} key={stock.id}>{stock.price}</td>
                            <td ref={change} class={Change} key={stock.id} data-trend={stock.trend()}>
                                {t.signed_money(Minor(i64::from(stock.price_cents) - i64::from(stock.open_cents)), USD)}
                                " "
                                {&stock.change}
                            </td>
                            <td>
                                <button
                                    class={Remove}
                                    form={WatchFormId}
                                    formaction={url::Unwatch}
                                    name={f.remove}
                                    value={stock.id}
                                    aria-label={("Remove ", &stock.name)}
                                >
                                    "Remove"
                                </button>
                            </td>
                        </tr>
                    }
                    if stocks.is_empty() {
                        <tr>
                            <td colspan="4" class={Empty}>
                                "You are not watching any stocks. Pick one, and its price shows here."
                            </td>
                        </tr>
                    }
                </tbody>
            </table>
            <p ref={updates} class={muted()}></p>
        </div>
    }
}

/// The price table.
#[derive(Id)]
struct PricesId;

/// The watch form: a watch or a removal replaces it, since its choices change.
#[derive(Id)]
struct WatchFormId;

/// The outcome of the last watch or removal, beside the form.
#[derive(Id)]
struct WatchMessageId;

/// What the last change did, or the notice on the page it redirects to without JavaScript.
#[component]
fn WatchMessage<'a>(message: &'a str, notice: Option<&'a Notice>) -> impl Patch {
    html! {
        <p id={WatchMessageId}>
            {message}
            if let Some(notice) = notice { {notice} }
        </p>
    }
}

/// Adds a stock to the list. The rows' Remove buttons belong to it too.
/// A change that got no answer (the network failed) leaves the
/// page as it was, and the form says so (`on:corten:error`); the next answer replaces it.
#[component(js)]
pub(crate) fn WatchForm<'a>(others: &'a [(&'static str, &'static str)]) -> impl Patch {
    let f = StockForm::FIELDS;
    let unanswered = refs();
    html! {
        <form
            id={WatchFormId}
            method="post"
            action={url::Watch}
            data-patch
            class={stack(Space::_3)}
            on:corten:error={js::failed(unanswered)}
        >
            <h2>"Watch a stock"</h2>
            if others.is_empty() {
                <p class={muted()}>"You are watching every stock on the market."</p>
            } else {
                <label class={stack(Space::_1)}>
                    <span class={muted()}>"Stock"</span>
                    <select name={f.id}>for (id, name) in others { <option value={id}>{name}" ("{id}")"</option> }</select>
                </label>
                <button class={w_full()}>"Watch"</button>
            }
            <p ref={unanswered} role="alert" hidden>"That change did not reach the market. Try again."</p>
        </form>
    }
}

/// The last trade: rendered inside the home page, then replaced by each fragment `/live/trades`
/// streams.
#[derive(Id)]
struct LastTradeId;

#[component]
fn LastTrade(text: &str) -> impl Patch {
    html! { <p id={LastTradeId}>{text}</p> }
}

/// The visitor's picks: drawn waiting in the home page, and replaced by the patch the runtime
/// reads from the page's route.
#[derive(Id)]
struct PicksId;

/// The picks waiting, with the runtime's read of them inside them (`ReadAgain::now`), which the
/// page's own handler answers (`page`) with the picks that replace them. Its link goes to the same
/// page with the picks read in, and shows unless a read is bringing them (`aria-busy`,
/// `picks_loading.css`): without JavaScript, which reads nothing, when the runtime's part module
/// does not load, and once the read has failed (`data-corten-read-failed`); the line saying they
/// are on their way shows only while one is, in the same place. `nofollow`, as the page it opens waits for the slow
/// read.
#[component(css)]
pub(crate) fn PicksLoading() -> impl Render {
    html! {
        <p id={PicksId} class={Waiting}>
            <span class={Finding}>"Finding picks for you..."</span>
            <a class={Show} href={url::Home { picks: Some(true) }} rel="nofollow">"Show picks for you"</a>
            {ReadAgain::now(url::Home::default())}
        </p>
    }
}

/// The picks, in the page that read them in and as the patch that answers the runtime's read.
#[component]
fn PicksList<'a>(picks: &'a [Stock]) -> impl Patch {
    html! {
        if picks.is_empty() {
            <p id={PicksId}>"You are watching every stock on the market."</p>
        } else {
            <ul id={PicksId} class={stack(Space::_1)}>
                for stock in picks {
                    <li>{stock.name}" ("{stock.id}") "{&stock.change}</li>
                }
            </ul>
        }
    }
}

/// The whole watchlist screen, for a browser or a data client; its callers add the list's cookie
/// for a browser that had none (`Watching::with_cookie`).
fn home_screen(req: &Req, viewer: Option<&Viewer>, home: &Home) -> HtmlResult {
    let view = home_view(home, req.t(), req.notice());
    req.screen(home, html! { <Layout req={req} title="Stocks" viewer={viewer} head="">{view}</Layout> })
}

/// The watchlist, and its picks alone when the runtime reads them (`ReadAgain::now` in the page):
/// one handler for the page and its slow part, each side reading only what it draws.
pub(crate) async fn page(
    req: Req,
    viewer: Option<Caller<Viewer>>,
    State(market): State<Market>,
    mut watching: Watching,
    Params(at): Params<url::Home>,
) -> HtmlResult<Patches> {
    let res = req
        .patch_or_with(
            |action| {
                let picks = market.picks(&watching.ids);
                async move { action.patch(PicksList { picks: &picks.await }) }
            },
            || async {
                // Read in only when the address asks (the link where no read will bring them):
                // otherwise the page goes without them and the runtime reads them.
                let picks = match at.picks {
                    Some(true) => Some(market.picks(&watching.ids).await),
                    _ => None,
                };
                home_screen(&req, viewer.as_deref(), &Home::new(&market, &watching, String::new(), picks))
            },
        )
        .await?;
    Ok(watching.with_cookie(res))
}

/// The stock a watch adds.
#[derive(Fields)]
pub(crate) struct StockForm {
    id: String,
}

/// The stock a row's Remove button takes off. The form's other fields (the stock picked to
/// watch) come along and are not read.
#[derive(Fields)]
pub(crate) struct UnwatchForm {
    remove: String,
}

pub(crate) async fn watch(
    req: Req,
    viewer: Option<Caller<Viewer>>,
    State(market): State<Market>,
    State(lists): State<Lists>,
    mut watching: Watching,
    zone: Option<ClientZone>,
    Form(form): Form<StockForm>,
) -> HtmlResult {
    let Some(mut message) = market.stocks.read(|rows| rows.get(&form.id).map(|s| format!("Watching {} at {}.", s.name, s.price)))
    else {
        return not_listed(&req, viewer.as_deref(), &market, &mut watching).await;
    };
    watching.add(&lists, &form.id);
    // The browser's zone, which the runtime keeps once a page has loaded: no script of the app's.
    if let Some(ClientZone(zone)) = zone {
        message.push_str(&format!(" Alerts follow {zone} time."));
    }
    changed(&req, viewer.as_deref(), &market, &mut watching, message)
}

pub(crate) async fn unwatch(
    req: Req,
    viewer: Option<Caller<Viewer>>,
    State(market): State<Market>,
    State(lists): State<Lists>,
    mut watching: Watching,
    Form(form): Form<UnwatchForm>,
) -> HtmlResult {
    let Some(message) = market.stocks.read(|rows| rows.get(&form.remove).map(|s| format!("Stopped watching {}.", s.name))) else {
        return not_listed(&req, viewer.as_deref(), &market, &mut watching).await;
    };
    watching.remove(&lists, &form.remove);
    changed(&req, viewer.as_deref(), &market, &mut watching, message)
}

/// What a watch or a removal of a stock the market does not list says.
const NOT_LISTED: &str = "That stock is not on the market.";

/// A watch or a removal of a stock the market does not list, refused (422) and the list left as it
/// is: the form saying so as a patch with JavaScript, the watchlist with the form saying so
/// without it (drawn at `/watch` or `/unwatch` only to refuse, as `req.invalid` draws a refusal),
/// and the Problem Details document for a data client.
async fn not_listed(req: &Req, viewer: Option<&Viewer>, market: &Market, watching: &mut Watching) -> HtmlResult {
    let mut errors = Errors::new();
    errors.add_form(NOT_LISTED);
    let home = &Home::new(market, watching, NOT_LISTED.into(), None);
    let form = html! {
        <WatchForm others={&home.others} />
        <WatchMessage message={&home.message} notice={None} />
    };
    req.invalid(&errors, form, || async move { Ok(watching.with_cookie(home_screen(req, viewer, home)?)) }).await
}

/// The answer to a change of the list: with JavaScript, the prices and the form as a patch; to a
/// native screen or an agent, the whole screen. `/watch` and `/unwatch` are paths of their own
/// (one form's two writes), so a browser without JavaScript is sent back to the watchlist, whose
/// form says what changed, once (`req.redirect_with_notice`); only a refusal is drawn there
/// (`not_listed`). The patch leaves the picks as they are, so until the page is read again they
/// can still name a stock just watched.
fn changed(req: &Req, viewer: Option<&Viewer>, market: &Market, watching: &mut Watching, message: String) -> HtmlResult {
    if let Some(action) = req.action() {
        let home = Home::new(market, watching, message, None);
        let res = action.patch(html! {
            <LivePrices stocks={&home.stocks} t={req.t()} />
            <WatchForm others={&home.others} />
            <WatchMessage message={&home.message} notice={None} />
        })?;
        return Ok(watching.with_cookie(res));
    }
    if req.mode == Mode::Data {
        let home = Home::new(market, watching, message, None);
        return Ok(watching.with_cookie(home_screen(req, viewer, &home)?));
    }
    Ok(watching.with_cookie(req.redirect_with_notice(&url::Home::default(), message)?))
}

#[cfg(test)]
mod tests {
    use corten::{http::StatusCode, testing::Client};

    use super::*;
    use crate::{
        app::url,
        news::url::News,
        testing::{VISITOR, client},
    };

    /// The tickers of the rows a page or patch shows, in order.
    fn rows(body: &str) -> Vec<&str> {
        body.split(r#"data-ref="price" class="live-prices__amount" data-key=""#).skip(1).map(|s| &s[..4]).collect()
    }

    /// The home page, as the visitor sees it.
    async fn watched(app: &Client) -> String {
        app.get(&url::Home::default()).cookie("visitor", VISITOR).await.text().to_string()
    }

    /// The visitor's Remove button on the row of `remove`, the stock picked to watch coming along.
    async fn unwatch(app: &Client, picked: &str, remove: &str) -> corten::testing::Answer {
        app.post(&url::Unwatch)
            .mode(Mode::Action)
            .cookie("visitor", VISITOR)
            .field(StockForm::FIELDS.id, picked)
            .field(UnwatchForm::FIELDS.remove, remove)
            .await
    }

    /// The scripts' rows and the smoke's screen data are checked against these declarations by
    /// `npm run check`.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new()
            .add::<Stock>()
            .add::<crate::smoke::Reading>()
            .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }

    #[test]
    fn last_trade_is_a_patch_of_only_the_message() {
        let trade: &dyn Patch = &LastTrade { text: "Last trade: <ACME>" };
        assert_eq!(trade.to_html(), r#"<p id="last-trade">Last trade: &lt;ACME&gt;</p>"#);
    }

    #[tokio::test]
    async fn home_renders_the_watched_stocks_and_script_for_browsers() {
        let res = client().get(&url::Home::default()).await;
        assert!(res.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
        let body = res.text();
        assert!(body.contains("/scripts/live_prices.js\">"), "the script module is preloaded: {body}");
        assert!(
            body.contains(r#"data-on='connect:live_prices.watch($c,@pause,#price,#change,%{"z":"0","s":[".",",",3,3,1],"t":["$\u0001","-$\u0001"],"d":2},%{"z":"0","s":[".",",",3,3,1],"t":["$\u0001","-$\u0001","+$\u0001"],"d":2},%{"z":"0","s":[".",",",3,3,1],"t":["\u0001%","-\u0001%","+\u0001%"],"p":2},"/feed/stocks",$s,@updates,%{"z":"0","s":[".",",",3,3,1],"t":["\u0001","-\u0001"],"c":""#),
            "the script gets the money and change formats and the message it fills in, once: {body}"
        );
        // The count's message is plural: both forms and English's table (0 is other, 1 one).
        let table = format!("51{}", "5".repeat(199));
        assert!(
            body.contains(&format!(
                r#""c":"{table}","m":[null,["","count"," price update"],null,null,null,["","count"," price updates"]]}})'"#
            )),
            "the plural message's forms: {body}"
        );
        assert!(
            body.contains(r#"<td data-ref="price" class="live-prices__amount" data-key="ACME">$129.99</td>"#),
            "server renders prices first: {body}"
        );
        assert!(
            body.contains(
                r#"<td data-ref="change" class="live-prices__change" data-key="ACME" data-trend="flat">$0.00 0.00%</td>"#
            ),
            "and today's change, in money and in the page's change format: {body}"
        );
        assert_eq!(rows(body), ["ACME", "GLBX", "INIT"], "a first visit watches three");
        assert!(
            body.contains(r#"<button class="live-prices__remove" form="watch-form" formaction="/unwatch" name="remove" value="ACME" aria-label="Remove Acme Corp">Remove</button>"#),
            "a row's Remove button submits the watch form: {body}"
        );
        assert!(body.contains(r#"<option value="HLTH">Halcyon Health (HLTH)</option>"#), "the others are the form's choices");
        assert!(!body.contains(r#"<option value="ACME">"#), "a watched stock is not offered again");
        assert!(body.contains(
            r#"<corten-live src="/live/trades" since="0" aria-live="polite"><p id="last-trade">No trades yet.</p></corten-live>"#
        ));
    }

    #[tokio::test]
    async fn a_browser_gets_a_visitor_id_once_and_keeps_its_list_on_the_server() {
        let app = client();
        let first = app.get(&url::Home::default()).await;
        let cookie = first.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.starts_with("visitor=") && cookie[8..].find(';') == Some(32), "{cookie}");
        assert!(cookie.ends_with("; Path=/; SameSite=Lax; Max-Age=31536000; HttpOnly; Secure"), "{cookie}");
        let res = app.post(&url::Watch).mode(Mode::Action).cookie("visitor", VISITOR).field(StockForm::FIELDS.id, "SOLR").await;
        assert!(res.headers().get("set-cookie").is_none(), "a browser with a list keeps its id");
        assert_eq!(rows(&watched(&app).await), ["ACME", "GLBX", "INIT", "SOLR"]);
        // Another browser, and a cookie the app did not write, see a list of their own.
        let other = app.get(&url::Home::default()).cookie("visitor", "nope").await;
        assert_eq!(rows(other.text()), ["ACME", "GLBX", "INIT"]);
    }

    #[tokio::test]
    async fn a_page_that_only_reads_the_list_makes_no_id() {
        let app = client();
        let mine = News { filter: crate::news::NewsQuery { mine: Some(true), ..Default::default() } };
        let res = app.get(&mine).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers().get("set-cookie").is_none(), "News reads the list and sets nothing");
        // A first change without a cookie names its new list once, in the answer.
        let res = app.post(&url::Watch).mode(Mode::Action).field(StockForm::FIELDS.id, "SOLR").await;
        let cookies: Vec<_> = res.headers().get_all("set-cookie").iter().map(|c| c.to_str().unwrap()).collect();
        assert!(cookies.len() == 1 && cookies[0].starts_with("visitor="), "{cookies:?}");
        let list = app.get(&url::Home::default()).cookie("visitor", res.cookie("visitor").unwrap()).await;
        assert_eq!(rows(list.text()), ["ACME", "GLBX", "INIT", "SOLR"]);
    }

    /// A browser with no id that sends a stock the market does not list gets none with the
    /// refusal's patch or Problem Details document, and one with the watchlist drawn to refuse it.
    #[tokio::test]
    async fn a_refusal_makes_an_id_only_when_it_draws_the_watchlist() {
        let app = client();
        for mode in [Mode::Action, Mode::Data] {
            let watch = app.post(&url::Watch).mode(mode).field(StockForm::FIELDS.id, "ZZZZ").await;
            let unwatch = app.post(&url::Unwatch).mode(mode).field(UnwatchForm::FIELDS.remove, "ZZZZ").await;
            for refused in [watch, unwatch] {
                assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY, "{mode:?}: {}", refused.text());
                let cookies: Vec<_> = refused.headers().get_all("set-cookie").iter().map(|c| c.to_str().unwrap()).collect();
                assert!(!cookies.iter().any(|c| c.starts_with("visitor=")), "{mode:?}: {cookies:?}");
            }
        }
        let drawn = app.post(&url::Watch).mode(Mode::Document).field(StockForm::FIELDS.id, "ZZZZ").await;
        assert_eq!(drawn.status(), StatusCode::UNPROCESSABLE_ENTITY, "{}", drawn.text());
        assert_eq!(drawn.cookie("visitor").map(str::len), Some(32), "the watchlist's page names the browser");
    }

    /// What a real write costs in process: a visitor's watch sent by the runtime (`corten: action`),
    /// answered with its patch (the prices and the form), `WRITE_REQUESTS` (200) times, one at a
    /// time. Counting it under callgrind at two numbers of requests gives the instructions per
    /// request, the write the cost a write pays in an app with layout reads is set against (#1370,
    /// docs/design.md#choice-write-own-page-whole). Run in release:
    /// `WRITE_REQUESTS=200 cargo test --release -p watchlist -- --ignored what_a_watch_costs`
    #[test]
    #[ignore]
    fn what_a_watch_costs() {
        let requests: usize = std::env::var("WRITE_REQUESTS").ok().and_then(|n| n.parse().ok()).unwrap_or(200);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            let app = client();
            for _ in 0..requests {
                let res =
                    app.post(&url::Watch).mode(Mode::Action).cookie("visitor", VISITOR).field(StockForm::FIELDS.id, "SOLR").await;
                assert!(res.status() == StatusCode::OK && res.text().contains("Watching Sunreach Solar"), "{}", res.text());
            }
        });
    }

    #[tokio::test]
    async fn two_removals_sent_at_once_both_land() {
        let app = client();
        let (a, b) = tokio::join!(unwatch(&app, "HLTH", "ACME"), unwatch(&app, "HLTH", "GLBX"));
        assert_eq!((a.status(), b.status()), (StatusCode::OK, StatusCode::OK));
        assert_eq!(rows(&watched(&app).await), ["INIT"]);
    }

    #[tokio::test]
    async fn an_empty_list_keeps_its_table_for_the_next_watch() {
        let app = client();
        for remove in ["ACME", "GLBX", "INIT"] {
            app.post(&url::Unwatch).mode(Mode::Action).cookie("visitor", VISITOR).field(UnwatchForm::FIELDS.remove, remove).await;
        }
        let page = watched(&app).await;
        assert!(page.contains("<tbody><tr><td colspan=\"4\"") && page.contains("You are not watching any stocks."), "{page}");
    }

    #[tokio::test]
    async fn home_is_json_for_data_clients() {
        let res = client().get(&url::Home::default()).mode(Mode::Data).await;
        assert_eq!(res.headers()["content-type"], "application/json");
        let body = res.text();
        assert!(
            body.starts_with(concat!(
                r#"{"title":"Stocks | Watchlist","data":{"stocks":[{"id":"ACME","name":"Acme Corp","price_cents":12999,"#,
                r#""open_cents":12999,"change_bp":0,"price":"$129.99","change":"0.00%"}"#
            )),
            "{body}"
        );
        assert!(!body.contains("HLTH") && !body.contains("trades_seen"), "only the watched stocks: {body}");
    }

    /// A slow part (#1264, #1400): the page goes without the picks and draws them waiting with
    /// the runtime's read of them inside them, which the same route answers with the picks alone;
    /// the waiting part links to the same page with them read in, for a browser without
    /// JavaScript, which reads nothing, and for a read that fails.
    #[tokio::test]
    async fn the_picks_come_later_or_read_in_for_a_browser_without_javascript() {
        let app = client();
        let page = app.get(&url::Home::default()).await;
        let page = page.text();
        assert!(
            page.contains(concat!(
                r#"<p id="picks" class="picks-loading__waiting"><span class="picks-loading__finding">Finding picks for you...</span>"#,
                r#"<a class="picks-loading__show" href="/?picks=true" rel="nofollow">Show picks for you</a>"#,
                r#"<template data-corten-read-now data-from="/"></template></p>"#
            )),
            "{page}"
        );
        // The runtime's read of the route gets the picks alone, as a patch: no page around them.
        let part = app.get(&url::Home::default()).mode(Mode::Action).await;
        assert!(part.headers().contains_key("corten-patch"), "{:?}", part.headers());
        let part = part.text();
        assert!(part.starts_with(r#"<ul id="picks""#) && part.contains("<li>Halcyon Health (HLTH) 0.00%</li>"), "{part}");
        assert!(!part.contains("Watchlist") && !part.contains("<html"), "{part}");
        // The link's page reads them in, so it has no waiting part, read or link for them.
        let read = app.get(&url::Home { picks: Some(true) }).await;
        let read = read.text();
        assert!(read.contains("<li>Halcyon Health (HLTH) 0.00%</li><li>Northgate Rail (NRTH) 0.00%</li></ul>"), "{read}");
        assert!(
            !read.contains("data-corten-read-now") && !read.contains("?picks=true") && !read.contains("Finding picks"),
            "{read}"
        );
        // A data client asks the same address for them; without it they are left out.
        let data = app.get(&url::Home { picks: Some(true) }).mode(Mode::Data).await;
        assert!(data.text().contains(r#""picks":[{"id":"HLTH","#), "{}", data.text());
        let data = app.get(&url::Home::default()).mode(Mode::Data).await;
        assert!(!data.text().contains("picks"), "{}", data.text());
    }

    #[tokio::test]
    async fn one_watch_handler_serves_every_surface() {
        let app = client();
        let watch = |mode| app.post(&url::Watch).mode(mode).field(StockForm::FIELDS.id, "HLTH");
        let patch = watch(Mode::Action).cookie("visitor", VISITOR).await;
        let patch = patch.text();
        assert!(patch.starts_with(r#"<div data-scope="live-prices" id="prices" "#), "the prices first: {patch}");
        assert_eq!(rows(patch), ["ACME", "GLBX", "INIT", "HLTH"]);
        assert!(patch.contains(r#"data-key="HLTH">$88.40</td>"#), "{patch}");
        assert!(
            patch.contains(r#"<form data-scope="watch-form" id="watch-form" method="post" action="/watch" data-patch"#),
            "{patch}"
        );
        assert!(!patch.contains(r#"<option value="HLTH">"#), "{patch}");
        assert!(patch.contains(r#"data-on='corten:error:watch_form.failed(@unanswered)'"#), "{patch}");
        assert!(
            patch.ends_with(concat!(
                r#"<p data-ref="unanswered" role="alert" hidden>That change did not reach the market. Try again.</p></form>"#,
                r#"<p id="watch-message">Watching Halcyon Health at $88.40.</p>"#
            )),
            "{patch}"
        );
        // Without JavaScript `/watch` has no page of its own: back to the watchlist, whose
        // status line says what changed, once.
        let sent = watch(Mode::Document).cookie("visitor", VISITOR).await;
        assert_eq!((sent.status(), sent.headers()["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/"));
        let notice = sent.cookie("__Host-corten-notice").unwrap();
        let page = app.get(&url::Home::default()).cookie("visitor", VISITOR).cookie("__Host-corten-notice", notice).await;
        let page = page.text();
        assert!(
            page.contains(r#"<div aria-live="polite"><p id="watch-message">Watching Halcyon Health at $88.40.</p></div>"#),
            "{page}"
        );
        assert_eq!(rows(page), ["ACME", "GLBX", "INIT", "HLTH"], "{page}");
        let data = watch(Mode::Data).await;
        assert_eq!(data.headers()["content-type"], "application/json");
        assert!(data.text().ends_with(r#""message":"Watching Halcyon Health at $88.40."}}"#), "{}", data.text());
    }

    /// Without JavaScript `/watch` and `/unwatch` have no page of their own: a change sends the
    /// browser back to the watchlist with what it did, and a stock the market does not list is
    /// refused where it was posted, the watchlist drawn there with a 422 and the list as it was.
    #[tokio::test]
    async fn without_javascript_a_change_goes_back_to_the_watchlist_and_a_refusal_is_drawn() {
        let app = client();
        let removed = app
            .post(&url::Unwatch)
            .mode(Mode::Document)
            .cookie("visitor", VISITOR)
            .field(UnwatchForm::FIELDS.remove, "GLBX")
            .await;
        assert_eq!((removed.status(), removed.headers()["location"].to_str().unwrap()), (StatusCode::SEE_OTHER, "/"));
        let notice = removed.cookie("__Host-corten-notice").unwrap();
        let page = app.get(&url::Home::default()).cookie("visitor", VISITOR).cookie("__Host-corten-notice", notice).await;
        let page = page.text();
        assert!(page.contains(r#"<p id="watch-message">Stopped watching Globex.</p>"#), "{page}");
        assert_eq!(rows(page), ["ACME", "INIT"]);
        let watch =
            app.post(&url::Watch).mode(Mode::Document).cookie("visitor", VISITOR).field(StockForm::FIELDS.id, "ZZZZ").await;
        let unwatch = app
            .post(&url::Unwatch)
            .mode(Mode::Document)
            .cookie("visitor", VISITOR)
            .field(UnwatchForm::FIELDS.remove, "ZZZZ")
            .await;
        for refused in [watch, unwatch] {
            let page = refused.text();
            assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY, "{page}");
            assert!(page.contains(r#"<p id="watch-message">That stock is not on the market.</p>"#), "{page}");
            assert_eq!(rows(page), ["ACME", "INIT"], "the list as it was");
        }
        // With JavaScript the refusal is the form, as a patch with the refusal's status; to a data
        // client, a Problem Details document (a 200 with the watchlist before #1340).
        let refuse_watch =
            |mode: Mode| app.post(&url::Watch).mode(mode).cookie("visitor", VISITOR).field(StockForm::FIELDS.id, "ZZZZ");
        let refuse_unwatch =
            |mode: Mode| app.post(&url::Unwatch).mode(mode).cookie("visitor", VISITOR).field(UnwatchForm::FIELDS.remove, "ZZZZ");
        for patch in [refuse_watch(Mode::Action).await, refuse_unwatch(Mode::Action).await] {
            assert_eq!(patch.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert!(patch.text().starts_with(r#"<form data-scope="watch-form" id="watch-form""#), "{}", patch.text());
            assert!(patch.text().contains("That stock is not on the market."), "{}", patch.text());
        }
        for data in [refuse_watch(Mode::Data).await, refuse_unwatch(Mode::Data).await] {
            let kind = data.headers()["content-type"].to_str().unwrap().to_string();
            assert_eq!(
                (data.status(), &kind[..]),
                (StatusCode::UNPROCESSABLE_ENTITY, "application/problem+json"),
                "{}",
                data.text()
            );
            assert!(data.text().contains("That stock is not on the market."), "{}", data.text());
        }
    }

    #[tokio::test]
    async fn removing_takes_the_stock_off_the_list_and_offers_it_again() {
        let patch = unwatch(&client(), "HLTH", "GLBX").await;
        let patch = patch.text();
        assert_eq!(rows(patch), ["ACME", "INIT"]);
        assert!(patch.contains(r#"<option value="GLBX">Globex (GLBX)</option>"#), "{patch}");
        assert!(patch.contains("Stopped watching Globex."), "{patch}");
    }

    /// Writes its children in an `<svg>`'s `<desc>`.
    #[component]
    fn Described(children: impl Render) -> impl Render {
        html! { <desc>{children}</desc> }
    }

    /// Markup with every call the key check puts in what `html!` writes: cells keyed by
    /// `key={..}`, one keyed by a static `key=".."`, a `<template>`'s, a `<noscript>`'s and a
    /// `<textarea>`'s content, and a `<template>` among a component's children in an `<svg>`.
    #[component]
    fn KeyedMarkup<'a>(ids: &'a [String]) -> impl Render {
        let (cell, total, mark) = refs();
        html! {
            <div>
                <table>
                    <tbody>
                        for id in ids {
                            <tr><td ref={cell} key={id.as_str()}>"1"</td></tr>
                        }
                    </tbody>
                    <tfoot><tr><td ref={total} key="total">"2"</td></tr></tfoot>
                </table>
                <template>
                    <table><tbody><tr><td ref={cell} key="row">"0"</td></tr></tbody></table>
                </template>
                <noscript><p>"Prices follow the market with JavaScript on."</p></noscript>
                <textarea name="note">{ids.len()}</textarea>
                <svg>
                    <Described>
                        <template><g ref={mark} key="row"></g></template>
                    </Described>
                </svg>
            </div>
        }
    }

    /// A document around `KeyedMarkup`: its head's `<title>` is the page's, in a document's head,
    /// and a navigation asks for its parts (`Part::Swap`, `Part::Title`). Its doctype is not a
    /// second root: the `<html>` holds the refs, so the document renders scoped, whole and in
    /// its parts; its `<main>` holds a keyed ref's element and a `<template>`
    /// of its own, beside `KeyedMarkup`'s.
    #[component]
    fn KeyedDocument<'a>(title: &'a str, ids: &'a [String]) -> impl Document {
        let lead = refs();
        html! {
            <!DOCTYPE html>
            <html lang="en">
                <head>
                    <meta charset="utf-8">
                    <title>{title}" | Watchlist"</title>
                    <Corten />
                </head>
                <body>
                    <main>
                        <p ref={lead} key="lead">{title}</p>
                        <template><p ref={lead} key="lead">{title}</p></template>
                        <KeyedMarkup ids={ids} />
                    </main>
                </body>
            </html>
        }
    }

    #[inline(never)]
    fn render_live_prices(stocks: &[Stock], rounds: usize) -> usize {
        let t = Msg::default();
        (0..rounds).map(|_| std::hint::black_box(LivePrices { stocks, t }.to_html()).len()).sum()
    }

    #[inline(never)]
    fn render_keyed_markup(ids: &[String], rounds: usize) -> usize {
        (0..rounds).map(|_| std::hint::black_box(KeyedMarkup { ids }.to_html()).len()).sum()
    }

    /// The whole document, then the parts a navigation asks for.
    #[inline(never)]
    fn render_keyed_document(ids: &[String], rounds: usize) -> usize {
        let doc = KeyedDocument { title: "Prices", ids };
        (0..rounds)
            .map(|_| {
                let mut out = doc.to_html();
                for part in [corten::view::Part::Swap, corten::view::Part::Title] {
                    corten::view::Document::render_part(&doc, &mut out, part);
                }
                std::hint::black_box(out).len()
            })
            .sum()
    }

    /// What the debug key check (`docs/design.md#choice-ref-values`) costs a release render, which
    /// should be nothing: `LivePrices` with 50 rows, each with two keyed cells, `KeyedMarkup`, and
    /// `KeyedDocument` around it, whole and in the parts a navigation asks for, 1,000 times each.
    /// Instructions, from the release test binary under callgrind:
    /// `cargo test --release -p watchlist --no-run`, then
    /// `valgrind --tool=callgrind <test binary> --ignored --exact home::tests::key_check_cost`
    /// and `callgrind_annotate --inclusive=yes` for `render_live_prices`, `render_keyed_markup`
    /// and `render_keyed_document`. To compare with a commit before the check, copy this test and
    /// the components above it into that commit's `home.rs`.
    #[test]
    #[ignore]
    fn key_check_cost() {
        let stocks: Vec<Stock> = (0..50u32)
            .map(|n| Stock {
                id: format!("S{n:03}"),
                name: format!("Stock {n}"),
                price_cents: 10_000 + n,
                open_cents: 10_000,
                change_bp: n as i32,
                price: format!("$100.{n:02}"),
                change: format!("+0.{n:02}%"),
            })
            .collect();
        let ids: Vec<String> = stocks.iter().map(|s| s.id.clone()).collect();
        let rounds = 1_000;
        let prices = render_live_prices(&stocks, rounds);
        let keyed = render_keyed_markup(&ids, rounds);
        let document = render_keyed_document(&ids, rounds);
        println!(
            "LivePrices: {} bytes a render, KeyedMarkup: {} bytes a render, KeyedDocument: {} bytes a render",
            prices / rounds,
            keyed / rounds,
            document / rounds
        );
    }
}
