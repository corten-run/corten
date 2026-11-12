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
}

impl Home {
    fn new(market: &Market, watching: &Watching, message: String) -> Self {
        let stocks = market.stocks.read(|rows| watching.ids.iter().filter_map(|id| rows.get(*id).cloned()).collect());
        let others = Market::listed().filter(|(id, _)| !watching.has(id)).collect();
        let (trades_seen, last_trade) = market.trades.borrow().clone();
        Home { stocks, last_trade, trades_seen, others, message }
    }
}

fn home_view(home: &Home, t: Msg) -> impl Render {
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
                <WatchForm others={&home.others} message={&home.message} />
                <section class={(card(), stack(Space::_2))}>
                    <h2>"Market activity"</h2>
                    <corten-live src={url::Trades} since={home.trades_seen}><LastTrade text={&home.last_trade} /></corten-live>
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

/// The outcome of the last watch or removal, in the form.
#[derive(Id)]
struct WatchMessageId;

/// Adds a stock to the list: the stocks not watched yet, and what the last change did. The rows'
/// Remove buttons belong to it too. A change that got no answer (the network failed) leaves the
/// page as it was, and the form says so (`on:corten:error`); the next answer replaces it.
#[component(js)]
pub(crate) fn WatchForm<'a>(others: &'a [(&'static str, &'static str)], message: &'a str) -> impl Patch {
    let f = StockForm::FIELDS;
    let unanswered = refs();
    html! {
        <form
            id={WatchFormId}
            method="post"
            action={url::Watch}
            data-patch
            class={(card(), stack(Space::_3))}
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
            <p id={WatchMessageId} aria-live="polite">{message}</p>
            <p ref={unanswered} role="alert" hidden>"That change did not reach the market. Try again."</p>
        </form>
    }
}

/// The last trade: rendered inside the home page, then replaced by each fragment `/live/trades`
/// streams.
#[derive(Id)]
struct LastTradeId;

#[component]
fn LastTrade(text: &str) -> impl Render {
    html! { <p id={LastTradeId} aria-live="polite">{text}</p> }
}

/// The whole watchlist screen, for a browser or a data client, with the list's cookie for a
/// browser that had none.
fn home_screen(req: &Req, viewer: Option<&Viewer>, watching: &mut Watching, home: &Home) -> HtmlResult {
    let view = home_view(home, req.t());
    let res = req.screen(home, html! { <Layout req={req} title="Stocks" viewer={viewer} head="">{view}</Layout> })?;
    Ok(watching.with_cookie(res))
}

pub(crate) async fn page(
    req: Req,
    viewer: Option<Caller<Viewer>>,
    State(market): State<Market>,
    mut watching: Watching,
) -> HtmlResult {
    let home = Home::new(&market, &watching, String::new());
    home_screen(&req, viewer.as_deref(), &mut watching, &home)
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
    let mut message = match market.stocks.read(|rows| rows.get(&form.id).map(|s| format!("Watching {} at {}.", s.name, s.price)))
    {
        Some(message) => {
            watching.add(&lists, &form.id);
            message
        }
        None => "That stock is not on the market.".into(),
    };
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
    let message = market
        .stocks
        .read(|rows| rows.get(&form.remove).map(|s| format!("Stopped watching {}.", s.name)))
        .unwrap_or_else(|| "That stock is not on the market.".into());
    watching.remove(&lists, &form.remove);
    changed(&req, viewer.as_deref(), &market, &mut watching, message)
}

/// The answer to a change of the list: with JavaScript, the prices and the form as a patch; without
/// it, or to a native screen or an agent, the whole screen.
fn changed(req: &Req, viewer: Option<&Viewer>, market: &Market, watching: &mut Watching, message: String) -> HtmlResult {
    let home = Home::new(market, watching, message);
    if req.mode != Mode::Action {
        return home_screen(req, viewer, watching, &home);
    }
    let res = req.patch(html! {
        <LivePrices stocks={&home.stocks} t={req.t()} />
        <WatchForm others={&home.others} message={&home.message} />
    })?;
    Ok(watching.with_cookie(res))
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
        app.get(&url::Home).cookie("visitor", VISITOR).await.text().to_string()
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

    /// The script's rows are checked against these declarations by `npm run check`.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new().add::<Stock>().sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }

    #[tokio::test]
    async fn home_renders_the_watched_stocks_and_script_for_browsers() {
        let res = client().get(&url::Home).await;
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
            r#"<corten-live src="/live/trades" since="0"><p id="last-trade" aria-live="polite">No trades yet.</p></corten-live>"#
        ));
    }

    #[tokio::test]
    async fn a_browser_gets_a_visitor_id_once_and_keeps_its_list_on_the_server() {
        let app = client();
        let first = app.get(&url::Home).await;
        let cookie = first.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.starts_with("visitor=") && cookie[8..].find(';') == Some(32), "{cookie}");
        assert!(cookie.ends_with("; Path=/; SameSite=Lax; Max-Age=31536000; HttpOnly; Secure"), "{cookie}");
        let res = app.post(&url::Watch).mode(Mode::Action).cookie("visitor", VISITOR).field(StockForm::FIELDS.id, "SOLR").await;
        assert!(res.headers().get("set-cookie").is_none(), "a browser with a list keeps its id");
        assert_eq!(rows(&watched(&app).await), ["ACME", "GLBX", "INIT", "SOLR"]);
        // Another browser, and a cookie the app did not write, see a list of their own.
        let other = app.get(&url::Home).cookie("visitor", "nope").await;
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
        let list = app.get(&url::Home).cookie("visitor", res.cookie("visitor").unwrap()).await;
        assert_eq!(rows(list.text()), ["ACME", "GLBX", "INIT", "SOLR"]);
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
        let res = client().get(&url::Home).mode(Mode::Data).await;
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
                r#"<p id="watch-message" aria-live="polite">Watching Halcyon Health at $88.40.</p>"#,
                r#"<p data-ref="unanswered" role="alert" hidden>That change did not reach the market. Try again.</p></form>"#
            )),
            "{patch}"
        );
        let page = watch(Mode::Document).await;
        assert!(page.headers()["content-type"].to_str().unwrap().starts_with("text/html"));
        assert!(page.text().contains("<html") && page.text().contains("Watching Halcyon Health"));
        let data = watch(Mode::Data).await;
        assert_eq!(data.headers()["content-type"], "application/json");
        assert!(data.text().ends_with(r#""message":"Watching Halcyon Health at $88.40."}}"#), "{}", data.text());
    }

    #[tokio::test]
    async fn removing_takes_the_stock_off_the_list_and_offers_it_again() {
        let patch = unwatch(&client(), "HLTH", "GLBX").await;
        let patch = patch.text();
        assert_eq!(rows(patch), ["ACME", "INIT"]);
        assert!(patch.contains(r#"<option value="GLBX">Globex (GLBX)</option>"#), "{patch}");
        assert!(patch.contains("Stopped watching Globex."), "{patch}");
    }
}
