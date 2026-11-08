//! Numeric marketplace records. Only formatter objects and input records survive requests.
use icu_decimal::{input::Decimal, DecimalFormatter};
use icu_experimental::dimension::currency::{formatter::CurrencyFormatter, CurrencyType};
use icu_plurals::{PluralCategory, PluralRules};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: String,
    pub categories: Vec<Category>,
    pub badges: Vec<String>,
    pub tags: Vec<String>,
    pub images: Vec<String>,
    pub fields: Vec<Field>,
    pub summary: Option<Summary>,
    pub listings: Vec<Listing>,
    pub offers: Vec<Offer>,
    pub contents: Vec<ContentLine>,
    pub included_in: Vec<ContentLine>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub name: String,
    pub slug: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub lowest_minor: Option<i64>,
    pub count: u64,
    pub quantity: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Listing {
    pub id: String,
    pub seller: String,
    pub rating_hundredths: Option<u16>,
    pub reviews: u64,
    pub condition: String,
    pub ships_from: String,
    pub quantity: u64,
    pub price_minor: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Offer {
    pub id: String,
    pub buyer: String,
    pub condition: String,
    pub quantity: u64,
    pub price_minor: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ContentLine {
    pub id: String,
    pub item_id: String,
    pub title: String,
    pub quantity: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Query {
    #[serde(default)]
    pub seller: String,
    #[serde(default)]
    pub sort: String,
    #[serde(default)]
    pub offers: String,
}
impl Query {
    pub fn descending(&self) -> bool {
        self.sort == "desc"
    }
    pub fn all(&self) -> bool {
        self.offers == "all"
    }
    pub fn more_href(&self, locale: Locale, id: &str) -> String {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("seller", &self.seller)
            .append_pair("sort", if self.descending() { "desc" } else { "asc" })
            .append_pair("offers", "all")
            .finish();
        format!("{}?{query}", locale.href(id))
    }
}
impl Record {
    pub fn listings(&self, query: &Query) -> Vec<&Listing> {
        let mut rows: Vec<_> = self.listings.iter().filter(|row| row.seller.starts_with(&query.seller)).collect();
        rows.sort_by(|a, b| match (a.price_minor, b.price_minor) {
            (Some(a), Some(b)) if query.descending() => b.cmp(&a),
            (Some(a), Some(b)) => a.cmp(&b),
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, None) => std::cmp::Ordering::Equal,
        });
        rows
    }
    pub fn offers(&self, query: &Query) -> &[Offer] {
        &self.offers[..if query.all() { self.offers.len() } else { self.offers.len().min(5) }]
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AlertForm {
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub target_price: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Locale(usize);
struct Formats {
    decimal: DecimalFormatter,
    money: CurrencyFormatter<DecimalFormatter>,
    plurals: PluralRules,
}
const TAGS: [&str; 3] = ["en-US", "fr-FR", "de-DE"];
static LABELS: LazyLock<HashMap<String, HashMap<String, String>>> =
    LazyLock::new(|| serde_json::from_str(include_str!("marketplace-labels.json")).expect("marketplace labels"));
static FORMATS: LazyLock<[Formats; 3]> = LazyLock::new(|| {
    TAGS.map(|tag| {
        let locale: icu_locale::Locale = tag.parse().expect("supported locale");
        Formats {
            decimal: DecimalFormatter::try_new(locale.clone().into(), Default::default()).expect("decimal locale data"),
            money: CurrencyFormatter::try_new_symbol(
                locale.clone().into(),
                CurrencyType::try_from_str("USD").unwrap(),
                Default::default(),
            )
            .expect("currency locale data"),
            plurals: PluralRules::try_new_cardinal(locale.into()).expect("plural locale data"),
        }
    })
});
impl Locale {
    pub fn parse(tag: &str) -> Option<Self> {
        TAGS.iter().position(|supported| *supported == tag).map(Self)
    }
    pub fn tag(self) -> &'static str {
        TAGS[self.0]
    }
    pub fn text(self, key: &str) -> &'static str {
        &LABELS[self.tag()][key]
    }
    pub fn count(self, count: u64) -> String {
        FORMATS[self.0].decimal.format(&Decimal::from(count)).to_string()
    }
    pub fn listing_count(self, count: u64) -> String {
        let key = match FORMATS[self.0].plurals.category_for(count) {
            PluralCategory::One => "listing_one",
            PluralCategory::Many => "listing_many",
            _ => "listing_other",
        };
        format!("{} {}", self.count(count), self.text(key))
    }
    pub fn money(self, minor: Option<i64>) -> String {
        let Some(minor) = minor else { return "\u{2014}".into() };
        let mut value = Decimal::from(minor);
        value.multiply_pow10(-2);
        self.currency(&value)
    }
    fn currency(self, value: &Decimal) -> String {
        FORMATS[self.0].money.format_fixed_decimal(value).to_string()
    }
    pub fn rating(self, hundredths: u16) -> String {
        // Round the integer input half away from zero before locale formatting.
        let tenths = (hundredths + 5) / 10;
        let value = if tenths % 10 == 0 {
            Decimal::from(tenths / 10)
        } else {
            let mut value = Decimal::from(tenths);
            value.multiply_pow10(-1);
            value
        };
        FORMATS[self.0].decimal.format(&value).to_string()
    }
    pub fn href(self, id: &str) -> String {
        let mut url = url::Url::parse("http://localhost/").unwrap();
        url.path_segments_mut().unwrap().extend(["marketplace", self.tag(), id]);
        url.path().to_string()
    }
    fn target(self, input: &str) -> Option<Decimal> {
        // Grouping is optional in the contract. Accept ungrouped locale decimals only,
        // never reinterpret the other locale's decimal mark as a grouping separator.
        let decimal = if self.0 == 0 { '.' } else { ',' };
        let input = input.trim();
        let mut marks = 0;
        let mut nonzero = false;
        for ch in input.chars() {
            if ch == decimal {
                marks += 1;
            } else if ch.is_ascii_digit() {
                nonzero |= ch != '0';
            } else {
                return None;
            }
        }
        if marks > 1 || !nonzero {
            return None;
        }
        input.replace(decimal, ".").parse().ok()
    }
    pub fn alert(self, record: &Record, form: &AlertForm) -> String {
        if !form.email.contains('@') {
            return self.text("invalid_email").into();
        }
        let Some(value) = self.target(&form.target_price) else {
            return self.text("invalid_price").into();
        };
        // Substitute once, so data resembling another placeholder stays data.
        let mut out = String::new();
        let mut remaining = self.text("alert_set");
        while let Some(start) = remaining.find('{') {
            out.push_str(&remaining[..start]);
            let Some(end) = remaining[start..].find('}') else {
                break;
            };
            let key = &remaining[start + 1..start + end];
            match key {
                "email" => out.push_str(&form.email),
                "title" => out.push_str(&record.title),
                "price" => out.push_str(&self.currency(&value)),
                _ => unreachable!("static alert label"),
            }
            remaining = &remaining[start + end + 1..];
        }
        out.push_str(remaining);
        out
    }
}

#[cfg(feature = "ssr")]
pub mod source {
    use super::Record;
    use std::{
        collections::HashMap,
        sync::{Arc, OnceLock},
    };
    pub enum Source {
        Fixture(HashMap<String, Arc<Record>>),
        Api { client: reqwest::Client, base: reqwest::Url },
    }
    static SOURCE: OnceLock<Source> = OnceLock::new();
    pub fn init() {
        let _ = source();
    }
    fn source() -> &'static Source {
        SOURCE.get_or_init(|| {
            if std::env::var("MARKETPLACE_SOURCE").as_deref() == Ok("fixture") {
                let path = std::env::var("MARKETPLACE_FIXTURE_PATH").unwrap_or_else(|_| "/fixtures/marketplace.json".into());
                let text = std::fs::read_to_string(path).expect("marketplace fixture file");
                return Source::Fixture(serde_json::from_str(&text).expect("marketplace numeric fixture"));
            }
            let base = std::env::var("API_BASE").unwrap_or_else(|_| "http://localhost:8080".into());
            Source::Api {
                client: reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().expect("HTTP client"),
                base: base.parse().expect("API_BASE is a URL"),
            }
        })
    }
    /// No memoization, pass-through JSON, or response cache.
    pub async fn get(id: &str) -> Result<Option<Arc<Record>>, String> {
        source().get(id).await
    }
    impl Source {
        pub async fn get(&self, id: &str) -> Result<Option<Arc<Record>>, String> {
            let (client, base) = match self {
                Self::Fixture(records) => return Ok(records.get(id).cloned()),
                Self::Api { client, base } => (client, base),
            };
            let mut url = base.clone();
            url.path_segments_mut().map_err(|()| "API_BASE cannot be a base URL")?.pop_if_empty().extend([
                "marketplace",
                "records",
                id,
            ]);
            let response = client.get(url).send().await.map_err(|error| error.to_string())?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!("marketplace API returned {}", response.status()));
            }
            response.json::<Record>().await.map(|record| Some(Arc::new(record))).map_err(|error| error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn record() -> Record {
        serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap()
    }
    #[cfg(feature = "ssr")]
    #[tokio::test]
    async fn http_source_fetches_once_parses_and_does_not_cache() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for index in 0..5 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(std::time::Duration::from_secs(10))).unwrap();
                let mut head = Vec::new();
                while !head.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    head.push(byte[0]);
                }
                paths.push(String::from_utf8(head).unwrap().lines().next().unwrap().to_string());
                let mut record = record();
                record.title = format!("Fresh {index}");
                let (status, body) = match index {
                    0 | 1 => ("200 OK", serde_json::to_string_pretty(&record).unwrap()),
                    2 => ("404 Not Found", "{}".into()),
                    3 => ("503 Service Unavailable", "{}".into()),
                    _ => ("200 OK", "{\"title\":\"incomplete\"}".into()),
                };
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            paths
        });
        let source =
            source::Source::Api { client: reqwest::Client::new(), base: format!("http://{addr}/root/").parse().unwrap() };
        for index in 0..2 {
            assert_eq!(source.get("id /?").await.unwrap().unwrap().title, format!("Fresh {index}"));
        }
        assert!(source.get("missing").await.unwrap().is_none());
        assert!(source.get("failure").await.is_err());
        assert!(source.get("bad-json").await.is_err());
        let paths = thread.join().unwrap();
        assert_eq!(paths.len(), 5);
        assert_eq!(paths[0], "GET /root/marketplace/records/id%20%2F%3F HTTP/1.1");
        assert_eq!(paths[0], paths[1]);
    }
    #[test]
    fn numeric_json_round_trip_preserves_nulls_and_empty_arrays() {
        let json: serde_json::Value = serde_json::from_str(include_str!("../tests/marketplace.json")).unwrap();
        assert_eq!(serde_json::to_value(record()).unwrap(), json);
    }
    #[test]
    fn locale_formats_currency_rating_grouping_and_cardinal_plurals() {
        for (tag, money, rating, count, zero, million) in [
            ("en-US", "$1,234.50", "4.3", "1,000", "0 listings", "1,000,000 listings"),
            ("fr-FR", "1 234,50 $US", "4,3", "1 000", "0 annonce", "1 000 000 d\u{2019}annonces"),
            ("de-DE", "1.234,50 $", "4,3", "1.000", "0 Angebote", "1.000.000 Angebote"),
        ] {
            let locale = Locale::parse(tag).unwrap();
            let spaces = |value: String| value.replace(['\u{a0}', '\u{202f}'], " ");
            assert_eq!(spaces(locale.money(Some(123450))), money);
            assert_eq!(locale.rating(425), rating);
            assert_eq!(locale.rating(475), if tag == "en-US" { "4.8" } else { "4,8" });
            assert_eq!(locale.rating(499), "5");
            assert_eq!(spaces(locale.count(1000)), count);
            assert_eq!(spaces(locale.listing_count(0)), zero);
            assert_eq!(spaces(locale.listing_count(1000000)), million);
            assert_eq!(locale.money(None), "\u{2014}");
            assert!(locale.money(Some(-123450)).contains('-'));
            assert!(locale.money(Some(1)).contains(if tag == "en-US" { "0.01" } else { "0,01" }));
        }
        assert!(Locale::parse("en").is_none());
    }
    #[test]
    fn stable_numeric_sort_prefix_filter_and_offer_limit() {
        let record = record();
        for (sort, ids) in [("asc", vec!["b", "c", "a", "d"]), ("desc", vec!["a", "b", "c", "d"])] {
            let query = Query { sort: sort.into(), ..Default::default() };
            assert_eq!(record.listings(&query).iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ids);
        }
        for (prefix, count) in [("", 4), ("Al", 2), ("al", 1), (" ", 1), (" Al", 1), ("  Al", 0)] {
            assert_eq!(record.listings(&Query { seller: prefix.into(), ..Default::default() }).len(), count);
        }
        assert_eq!(record.offers(&Query::default()).len(), 5);
        assert_eq!(record.offers(&Query { offers: "all".into(), ..Default::default() }).len(), 6);
        let locale = Locale::parse("fr-FR").unwrap();
        let href = Query { seller: "Al &+".into(), sort: "desc".into(), ..Default::default() }.more_href(locale, "id /?&");
        let url = url::Url::parse(&format!("http://localhost{href}")).unwrap();
        assert!(url.path().ends_with("/id%20%2F%3F&"));
        assert_eq!(url.query_pairs().find(|(k, _)| k == "seller").unwrap().1, "Al &+");
    }
    #[test]
    fn alert_validates_locale_input_without_changing_content() {
        let record = record();
        for tag in TAGS {
            let locale = Locale::parse(tag).unwrap();
            assert_eq!(locale.alert(&record, &AlertForm::default()), locale.text("invalid_email"));
            for price in ["0", "-1", "NaN", "Infinity", "1x", "1,2,3"] {
                let form = AlertForm { email: "x@y".into(), target_price: price.into() };
                assert_eq!(locale.alert(&record, &form), locale.text("invalid_price"));
            }
            let form = AlertForm {
                email: "{title}@example.test".into(),
                target_price: if tag == "en-US" { "1234.50" } else { "1234,50" }.into(),
            };
            let message = locale.alert(&record, &form);
            assert!(message.contains(&form.email));
            assert!(message.contains(&record.title));
            assert!(message.contains(&locale.money(Some(123450))));
            let wrong = AlertForm { target_price: if tag == "en-US" { "12,50" } else { "12.50" }.into(), ..form };
            assert_eq!(locale.alert(&record, &wrong), locale.text("invalid_price"));
        }
    }
}
