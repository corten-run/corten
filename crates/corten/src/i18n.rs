//! Typed messages: catalogs checked and compiled when the app builds.
//!
//! ```ignore
//! corten::i18n::messages! {
//!     pub struct Msg {
//!         "en" => "locales/en.json",      // the first is the default and the reference
//!         "fr" => "locales/fr.json",
//!     }
//! }
//!
//! let t: Msg = req.t();                    // negotiated from Accept-Language
//! html! { <h2>{t.item_listings()}</h2><span>{t.item_listing_count(summary.count)}</span> }
//! ```
//!
//! Catalogs are JSON objects of strings; nested objects make dotted keys, and each key is a method
//! (`item.listing_count` is `item_listing_count`). `{name}` in a message is an argument, so
//! `"{count} listings"` takes one parameter, `count`, an [`Arg`]: text, an integer, or a value `t`
//! formats (`t.number(..)`, `t.money(..)`, `t.date(..)`); `{{` is a brace. An
//! argument may be named like a Rust keyword (`{type}` is the parameter `r#type`) or in camel
//! case (`{updatedAt}` is the parameter `updated_at`), so a catalog shared with other apps
//! compiles as it is; `by_key` and `Message<"updatedAt">` use the catalog's names.
//!
//! A message with two or more arguments takes them by name, in a struct named after its method,
//! so two values cannot trade places and rewording the default text, which moves its arguments,
//! moves no call: `"{title} image {n}"` is `t.item_image(msg::ItemImage { title, n })`. The
//! structs are in a module `messages!` adds beside the catalog, named after it in snake case
//! (`Msg`'s is `msg`, `Type`'s `r#type`) and as visible as it, so an item of that name in the
//! same module clashes with it. Two keys whose structs would have one name (`itemImage` and
//! `item_image`) fail the build.
//!
//! What fails the build: a key one catalog has and another lacks, a message whose arguments
//! differ between locales, a plural message without a form its locale needs (below), a misspelled
//! key or a missing argument at the call site, a brace that is not an argument, and a value that
//! is not a string. Changing a catalog file rebuilds the
//! crate. The messages are split into text and arguments at compile time: a message without
//! arguments is a `&'static str`, and one with arguments writes its pieces straight into the page,
//! escaped, with no lookup and no intermediate string.
//!
//! # A message chosen at run time
//!
//! An API that answers with a message key and its arguments, for the client to show in the user's
//! locale, names a message the page cannot name in its source. `t.by_key(key, &args)` finds it by
//! its catalog key (the dotted key as written in the JSON) and fills its arguments by name from
//! `args` (an [`Args`]: pairs, a map, or a JSON object of the answer). It is `None` when the
//! catalog has no such key or `args` lacks one of the message's arguments, so the page decides what
//! to show instead, and it renders escaped like any other message:
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
//! use corten::i18n::Messages as _;
//!
//! let fr = Msg::for_locale("fr");
//! let found = fr.by_key("item.image", &[("title", "<Pika>"), ("n", "2")]).unwrap();
//! assert_eq!(found.to_string(), "Image 2 de <Pika>");
//! assert!(fr.by_key("item.missing", &[("n", 1)]).is_none(), "no such key");
//! assert!(fr.by_key("item.image", &[("n", 1)]).is_none(), "no title");
//! ```
//!
//! # Counts
//!
//! A message that depends on a count has a form per plural category, with the suffixes i18next
//! uses: `"listing_count_one": "{count} listing"` and `"listing_count_other": "{count} listings"`
//! are one message, `t.item_listing_count(count)`, which picks the form by the count's category
//! in the locale (CLDR's rules: `zero`, `one`, `two`, `few`, `many`, `other`) and writes
//! `{count}` as `t.number` does. The count is a [`Count`], a whole number of any integer type;
//! with other arguments, the method takes a struct whose `count` field is the count. A catalog
//! has exactly the forms its language's whole numbers use, and `_other`: English needs `_one`
//! and `_other`, French also `_many` (`1 000 000 d’annonces`), and Japanese `_other` alone.
//! `by_key` finds the message by the key without a suffix and picks its form by the `count`
//! argument.
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
//! use corten::i18n::Messages as _;
//!
//! let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
//! assert_eq!(en.item_listing_count(1).to_string(), "1 listing");
//! assert_eq!(en.item_listing_count(1234).to_string(), "1,234 listings");
//! assert_eq!(fr.item_listing_count(0).to_string(), "0 annonce");
//! assert_eq!(fr.item_listing_count(2_000_000).to_string(), "2\u{202f}000\u{202f}000 d’annonces");
//! assert_eq!(fr.by_key("item.listing_count", &[("count", 1)]).unwrap().to_string(), "1 annonce");
//! ```
//!
//! A catalog without a form its language uses does not compile (French uses `_many` for a
//! million):
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr-no-many.json" } }
//! ```
//!
//! Nor one with a form its language never uses: English has no whole number in `zero`, so a text
//! for no listings is a message of its own, chosen in the view:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en-zero.json" } }
//! ```
//!
//! Nor a plural message without `_other`:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en-no-other.json" } }
//! ```
//!
//! Nor two keys whose argument structs would have one name (`itemImage` and `item_image` are
//! both `ItemImage`):
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/struct-clash.json" } }
//! ```
//!
//! Nor a count that is not a whole number:
//!
//! ```compile_fail,E0277
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! let _ = Msg::default().item_listing_count(2.5);
//! ```
//!
//! A catalog named like a Rust keyword has its structs in a raw module:
//!
//! ```
//! corten::i18n::messages! { struct Type { "en" => "src/i18n/en.json" } }
//! let image = Type::default().item_image(r#type::ItemImage { title: "Pika", n: 2 });
//! assert_eq!(image.to_string(), "Pika image 2");
//! ```
//!
//! # Numbers, money and dates
//!
//! `t` writes them in its locale too, on the server, so a page shows a price or a time in the
//! reader's form with no script and nothing that changes after it loads:
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
//! use corten::i18n::{Currency, DateStyle, DayStyle, Decimal, Messages as _, Minor, MonthStyle, Offset, TimeStyle};
//! const USD: Currency = Currency::new("USD");
//!
//! let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
//! assert_eq!(en.number(1234567).to_string(), "1,234,567");
//! assert_eq!(en.money(Minor(123450), USD).to_string(), "$1,234.50");
//! assert_eq!(fr.money(Minor(123450), USD).to_string(), "1\u{202f}234,50\u{a0}$US");
//! // An amount an API sends as text: never a float.
//! assert_eq!(en.money(Decimal::parse("21.50").unwrap(), Currency::new("EUR")).to_string(), "€21.50");
//!
//! let at = corten::i18n::parse_timestamp("2026-03-22T12:00:00Z").unwrap(); // or any Into<SystemTime>
//! assert_eq!(en.date_time(at, DateStyle::Medium, TimeStyle::Short).to_string(), "Mar 22, 2026, 12:00 PM UTC");
//! assert_eq!(fr.date(at, DateStyle::Long).to_string(), "22 mars 2026");
//! // The month and year alone, in the locale's words: "Member since March 2026".
//! assert_eq!(en.date(at, MonthStyle::Long).to_string(), "March 2026");
//! assert_eq!(fr.date(at, MonthStyle::Short).to_string(), "mars 2026");
//! // The month and day alone, for a chart's axis whose year the page says once.
//! assert_eq!(en.date(at, DayStyle::Short).to_string(), "Mar 22");
//! assert_eq!(fr.date(at, DayStyle::Long).to_string(), "22 mars");
//! assert_eq!(en.time(at, TimeStyle::Short).zone(Offset::hours(-5)).to_string(), "7:00 AM GMT-5");
//! // A message argument like any other ("{title} image {n}"). Two or more are passed by name,
//! // in the catalog's module (`msg` for `Msg`), so they cannot trade places.
//! assert_eq!(en.item_image(msg::ItemImage { title: "Pika", n: en.number(1234) }).to_string(), "Pika image 1,234");
//! ```
//!
//! Each renders escaped in `html!`, as text or an attribute value. The data (separators, currency
//! symbols, date patterns, month names) is CLDR's, as Intl in Node writes it, checked against Intl
//! for every locale (`scripts/locale-data.mjs`). `messages!` puts in the app only the locales it
//! lists, and it is linked only when the app formats something (measured: `examples/watchlist`, `en`,
//! grew 22.9 KB with the code; card-market, `en` and `fr`, not at all). A tag without data of its
//! own has its language's (`fr-LU` is `fr`), and a language Corten has no data for is a build
//! error. Numbers are written in the locale's digits (`fa` has `۱٬۲۳۴`), dates in the Gregorian
//! calendar.
//!
//! - `t.number(n)`: an integer or a [`Decimal`], with the fraction digits it has.
//! - `t.money(amount, currency)`: [`Minor`] units (`Minor(123450)` cents) or a [`Decimal`] in the
//!   major unit, with the digits the [`Currency`] is shown with (2, 0 for JPY, 3 for KWD), rounded
//!   half away from zero. A bare integer does not compile, since it could be either:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! let price = Msg::default().money(123450, corten::i18n::Currency::new("USD"));
//! ```
//!
//! - `t.signed_money(amount, currency)`: the same, with its sign (a difference between two amounts),
//!   as Intl's `signDisplay: "exceptZero"` writes it: a plus sign on a gain, none on what rounds
//!   to zero, where the locale puts it:
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
//! use corten::i18n::{Currency, Messages as _, Minor};
//! const USD: Currency = Currency::new("USD");
//! let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
//! assert_eq!(en.signed_money(Minor(320), USD).to_string(), "+$3.20");
//! assert_eq!(en.signed_money(Minor(-123), USD).to_string(), "-$1.23");
//! assert_eq!(en.signed_money(Minor(0), USD).to_string(), "$0.00");
//! assert_eq!(fr.signed_money(Minor(320), USD).to_string(), "+3,20\u{a0}$US");
//! ```
//!
//! - `t.parse_money(text, currency)`: what `t.money` writes, read back from what a person typed
//!   into a form, in [`Minor`] units. The locale's own form, with or without the symbol, the code,
//!   the group separators or the fraction; anything else is `None`:
//!
//! ```
//! # corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
//! use corten::i18n::{Currency, Messages as _, Minor};
//! const USD: Currency = Currency::new("USD");
//! let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
//! assert_eq!(en.parse_money("$1,299.50", USD), Some(Minor(129950)));
//! assert_eq!(fr.parse_money("12,50", USD), Some(Minor(1250)));
//! assert_eq!(fr.parse_money("12.50", USD), None); // en's decimal point on a French page
//! assert_eq!(en.parse_money("1.234", USD), None); // a tenth of a cent
//! ```
//!
//! - `t.date(at, DateStyle)`, `t.time(at, TimeStyle)` and `t.date_time(at, DateStyle,
//!   TimeStyle)`: Intl's date styles (`Short` is `3/22/2026`, `Medium` `Mar 22, 2026`, `Long`
//!   `March 22, 2026`, `Full` with the weekday) and a time with its zone (`3:04 PM UTC`, `Medium`
//!   with seconds). `at` is a `SystemTime` or anything that converts to one (`chrono`'s, `jiff`'s
//!   and `time`'s timestamps do), and [`parse_timestamp`] reads RFC 3339 text. The zone is UTC,
//!   so a page reads the same wherever it is rendered, except that with the `zones` feature and
//!   `App::zoned_dates` it is the visitor's while Corten renders a request's answer
//!   (`req.zone()`); `.zone(z)` takes a [`Zone`]: an [`Offset`], or a zone with daylight
//!   saving time that gives its offset at the instant (`Visitor`). Another zone is written as its
//!   offset (`GMT-5`).
//! - `t.date(at, MonthStyle)`: the month and year without the day (`Short` is `Mar 2026`, `Long`
//!   `March 2026`), in the locale's order and words, for a "Member since" line or a release
//!   month. It has no time, so `t.date_time` does not take one.
//! - `t.date(at, DayStyle)`: the month and day without the year (`Short` is `Mar 22`, `Long`
//!   `March 22`; `22 mars` in `fr`), for a chart's axis, a week's row or a timeline whose year the
//!   page says once. Neither takes a time:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! use corten::i18n::{Messages as _, MonthStyle, TimeStyle};
//! let joined = Msg::default().date_time(std::time::SystemTime::now(), MonthStyle::Long, TimeStyle::Short);
//! ```
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! use corten::i18n::{DayStyle, Messages as _, TimeStyle};
//! let joined = Msg::default().date_time(std::time::SystemTime::now(), DayStyle::Short, TimeStyle::Short);
//! ```
//!
//! An app with one locale may keep no fixed text in its catalog (the views guide, Text), and
//! use it only for `t`'s formats. An empty catalog compiles with warnings denied:
//!
//! ```
//! #![deny(warnings)]
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/empty.json" } }
//! let t = Msg::default();
//! assert_eq!(t.number(1234).to_string(), "1,234");
//! assert!(t.by_key("anything", &[("n", 1)]).is_none());
//! ```
//!
//! Nor does a locale with no data, or its language's:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "tlh" => "src/i18n/en.json" } }
//! ```
//!
//! A currency is a valid code, checked when the build evaluates the `const`:
//!
//! ```compile_fail
//! const USD: corten::i18n::Currency = corten::i18n::Currency::new("US");
//! ```
//!
//! # Text a script fills in
//!
//! Text that depends on what a script computed ("3 selected") is a message too. `t.js()` has
//! the messages with arguments unfilled, and a handler takes one as a function: the markup passes
//! `js::count(total, t.js().rows_selected())`, the script's JSDoc says
//! `@param {Message<"count">} label` (`Message` from `"corten"`) and it shows
//! `label({ count: 3 })` with `textContent`. Only the messages a page passes are sent, in the
//! request's locale, as their text and argument names, in the `data-on` attribute
//! (`%["","count"," selected"]`), so the browser formats it with no catalog and no round trip.
//! A plural message (`t.js().item_listing_count()`) is sent with its forms, the locale's plural
//! table and its number format (`%{..}`, about 300 bytes more), so `label({ count: 1234 })` picks
//! the form and writes `1,234` exactly as the server would; a `count` passed as text is written
//! as given, and one that is not a whole number takes the `_other` form.
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! use corten::script::{message_id, ts::Message, Arg};
//! fn wants_a_count(_: impl Arg<Message<{ message_id(&["count"]) }>>) {}
//! wants_a_count(Msg::default().js().item_listing_count()); // "{count} listing" | "{count} listings"
//! ```
//!
//! A message whose arguments are not the ones the JSDoc names does not compile:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! fn wants_a_count(_: impl corten::script::Arg<corten::script::ts::Message<{ corten::script::message_id(&["count"]) }>>) {}
//! wants_a_count(Msg::default().js().item_image()); // takes {title} and {n}
//! ```
//!
//! A number, an amount or a date a script works out is written with the page's format, so it is
//! what the server would have rendered: `t.js().number()`, `t.js().money(USD)` (or
//! `t.js().signed_money(USD)`) and
//! `t.js().date(DateStyle::Short)` (or `.time(..)`, `.date_time(..)`, in UTC unless
//! `.zone(Offset::hours(-5))`) and `t.js().percent(2)` (or `t.js().change(2)`) are passed to a
//! handler whose JSDoc takes a `NumberFormat`, `MoneyFormat`, `DateFormat` or `PercentFormat`
//! (from `"corten"`), and the script calls `price(123450)` (minor units), `when(Date.now())` or
//! `rate(0.029)`. The format is sent as the locale's separators, templates and
//! names (`%{..}`), and the runtime writes with the same algorithm (`scripts/format.mjs` checks
//! it on every case the server is checked on), not the browser's `Intl`, whose data differs by
//! browser and version. A zone with daylight saving time has no fixed offset to send: write
//! those dates on the server.
//!
//! ```
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! use corten::script::{ts, Arg};
//! fn wants_money(_: impl Arg<ts::MoneyFormat>) {}
//! wants_money(Msg::default().js().money(corten::i18n::Currency::new("USD")));
//! ```
//!
//! A format of another kind does not compile:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! fn wants_money(_: impl corten::script::Arg<corten::script::ts::MoneyFormat>) {}
//! wants_money(Msg::default().js().number());
//! ```
//!
//! ```
//! corten::i18n::messages! {
//!     struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" }
//! }
//! use corten::i18n::Messages as _;
//!
//! let t = Msg::negotiate(Some("fr"));
//! assert_eq!(t.item_listing_count(3).to_string(), "3 annonces");
//! ```
//!
//! A catalog without one of the default's keys does not compile:
//!
//! ```compile_fail
//! corten::i18n::messages! {
//!     struct Msg { "en" => "src/i18n/en.json", "de" => "src/i18n/missing-key.json" }
//! }
//! ```
//!
//! Nor one whose message takes different arguments:
//!
//! ```compile_fail
//! corten::i18n::messages! {
//!     struct Msg { "en" => "src/i18n/en.json", "de" => "src/i18n/other-args.json" }
//! }
//! ```
//!
//! Nor a call that leaves out an argument, or a key that does not exist:
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! let text = Msg::default().item_listing_count().to_string();
//! ```
//!
//! ```compile_fail
//! corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json" } }
//! let text = Msg::default().item_listing();
//! ```

use std::fmt::{self, Display};

use crate::view::{escape_display, escape_into, AttrValue, Render};

mod display_digits;
mod format;
pub(crate) use format::civil_from_days;
mod visitor;

pub(crate) use visitor::Scope;
#[cfg(feature = "zones")]
pub use visitor::Visitor;
#[cfg(feature = "zones")]
pub(crate) use visitor::ZoneScope;

pub use format::{
    parse_timestamp, Amount, Count, Currency, DateFormat, DateOnly, DateStyle, DateValue, Datetime, Day, DayStyle, Decimal,
    Formatted, InvalidDay, InvalidDecimal, Minor, MoneyFormat, MonthStyle, Number, NumberFormat, Offset, OnDay, PercentFormat,
    Relative, RelativeStyle, TimeStyle, Utc, When, Zone,
};

/// Compiles catalogs into a messages type. See the [module docs](self).
pub use corten_macros::messages;

/// A type from [`messages!`]: one locale of the app's catalogs.
pub trait Messages: Copy + 'static {
    /// The locales, default first.
    const LOCALES: &'static [&'static str];
    /// The locale at `index` in [`Messages::LOCALES`], or the default when out of range.
    fn from_index(index: usize) -> Self;
    fn index(self) -> usize;

    /// This locale's tag, as listed in `messages!`.
    fn locale(self) -> &'static str {
        Self::LOCALES[self.index()]
    }

    /// The best locale for an `Accept-Language` header.
    fn negotiate(accept_language: Option<&str>) -> Self {
        Self::from_index(negotiate(Self::LOCALES, accept_language))
    }

    /// The locale with this tag (case-insensitive), or the default.
    fn for_locale(tag: &str) -> Self {
        Self::from_index(Self::LOCALES.iter().position(|l| l.eq_ignore_ascii_case(tag)).unwrap_or(0))
    }
}

/// A locale of the app's messages as a URL names it: a route field (`/{lang}/listings` with
/// `lang: Locale<Msg>`) whose tag is one `M` lists, written as that tag and read only as it is
/// written (`/FR/listings` would be a second URL for one page, so it does not read; nor does a tag
/// `M` does not list: either is refused as any path parameter that does not read is, 400), for a
/// page whose locale is in its URL rather than its `Accept-Language` ([`crate::Req::set_locale`]).
///
/// ```
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
/// use corten::i18n::{Locale, Messages as _};
///
/// let fr = Locale::of(Msg::for_locale("fr"));
/// assert_eq!(fr.to_string(), "fr");
/// assert_eq!(fr.messages().item_listings().to_string(), "Annonces");
/// assert_eq!(Locale::<Msg>::parse("fr"), Some(fr));
/// assert_eq!(Locale::<Msg>::parse("FR"), None, "one URL per locale");
/// assert_eq!(Locale::<Msg>::parse("de"), None, "not one of the app's");
///
/// use serde::{de::value::{Error, StrDeserializer}, Deserialize};
/// assert_eq!(Locale::<Msg>::deserialize(StrDeserializer::<Error>::new("fr")), Ok(fr));
/// assert!(Locale::<Msg>::deserialize(StrDeserializer::<Error>::new("de")).is_err());
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Locale<M>(M);

impl<M: Messages> Locale<M> {
    /// The locale `messages` are in.
    pub fn of(messages: M) -> Self {
        Locale(messages)
    }

    /// The app's messages in this locale.
    pub fn messages(self) -> M {
        self.0
    }

    /// The locale with this tag, exactly as `M` lists it, or `None`.
    pub fn parse(tag: &str) -> Option<Self> {
        M::LOCALES.iter().position(|l| *l == tag).map(|index| Locale(M::from_index(index)))
    }
}

impl<M: Messages> Display for Locale<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0.locale())
    }
}

impl<'de, M: Messages> serde::Deserialize<'de> for Locale<M> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Tag<M>(std::marker::PhantomData<M>);
        impl<M: Messages> serde::de::Visitor<'_> for Tag<M> {
            type Value = Locale<M>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "one of the locales {}", M::LOCALES.join(", "))
            }
            fn visit_str<E: serde::de::Error>(self, tag: &str) -> Result<Locale<M>, E> {
                Locale::parse(tag).ok_or_else(|| E::invalid_value(serde::de::Unexpected::Str(tag), &self))
            }
        }
        deserializer.deserialize_str(Tag(std::marker::PhantomData))
    }
}

/// The index in `locales` that best matches an `Accept-Language` header: highest `q` first, an
/// exact tag before the primary language (`fr-CA` matches `fr`), then 0. Allocates nothing.
pub fn negotiate(locales: &[&str], accept_language: Option<&str>) -> usize {
    let mut best: Option<(f32, usize)> = None;
    for part in accept_language.unwrap_or("").split(',') {
        let mut pieces = part.trim().split(';');
        let tag = pieces.next().unwrap_or("").trim();
        let q = match pieces.find_map(|p| p.trim().strip_prefix("q=")) {
            Some(q) => match q.parse::<f32>() {
                Ok(q) => q,
                Err(_) => continue,
            },
            None => 1.0,
        };
        if tag.is_empty() || tag == "*" || q <= 0.0 || best.is_some_and(|(b, _)| q <= b) {
            continue;
        }
        let primary = tag.split('-').next().unwrap_or(tag);
        let found = locales
            .iter()
            .position(|l| l.eq_ignore_ascii_case(tag))
            .or_else(|| locales.iter().position(|l| l.split('-').next().unwrap_or("").eq_ignore_ascii_case(primary)));
        if let Some(index) = found {
            best = Some((q, index));
        }
    }
    best.map_or(0, |(_, index)| index)
}

/// Where a message writes: the page (escaped) or plain text.
pub struct Sink<'a> {
    out: &'a mut String,
    html: bool,
}

impl Sink<'_> {
    /// A run of the message's own text, given plain and already escaped: for `messages!` alone,
    /// since it writes `html` as it is. An [`Arg`] writes with [`Sink::str`] or [`Sink::display`].
    #[doc(hidden)]
    #[inline]
    pub fn text(&mut self, plain: &str, html: &str) {
        self.out.push_str(if self.html { html } else { plain });
    }

    /// An argument, which writes itself ([`Arg`]).
    #[inline]
    pub fn arg<T: Arg + ?Sized>(&mut self, value: &T) {
        value.write_arg(self)
    }

    /// Text: escaped in a page, as is in plain text.
    #[inline]
    pub fn str(&mut self, text: &str) {
        if self.html {
            escape_into(text, self.out);
        } else {
            self.out.push_str(text);
        }
    }

    /// A `Display` value's text: escaped in a page, as is in plain text.
    pub fn display(&mut self, value: &(impl Display + ?Sized)) {
        if self.html {
            escape_display(value, self.out);
        } else {
            let _ = fmt::Write::write_fmt(self.out, format_args!("{value}"));
        }
    }

    /// Text that needs no escaping (digits, the locale's own formats).
    #[inline]
    fn plain(&mut self, text: &str) {
        self.out.push_str(text);
    }

    /// An integer's digits, which need no escaping.
    #[inline]
    fn integer(&mut self, n: u64) {
        crate::view::push_u64(n, self.out);
    }
}

/// A value a message puts in its text: text (`&str`, `String`), an integer, or what `t` formats
/// in the locale (`t.number(..)`, `t.money(..)`, `t.date(..)`) or another message. An integer
/// is written as its digits, as a script's message writes it (`String(n)`), with no
/// `core::fmt` on the way; a number a reader reads as an amount goes through `t.number`. A
/// float is none of these: `t.number(Decimal::..)` writes it in the reader's form. A type of the
/// app's own implements it with the `Sink` it gets:
///
/// ```
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
/// use corten::i18n::{Arg, Messages as _, Sink};
/// use corten::prelude::*;
///
/// enum Grade { Mint, Played }
/// impl Arg for Grade {
///     fn write_arg(&self, sink: &mut Sink<'_>) {
///         sink.str(match self { Grade::Mint => "<Mint>", Grade::Played => "Played" })
///     }
/// }
///
/// let en = Msg::for_locale("en");
/// assert_eq!(en.item_image(msg::ItemImage { title: Grade::Mint, n: 12 }).to_html(), "&lt;Mint&gt; image 12");
/// assert_eq!(en.item_image(msg::ItemImage { title: &Grade::Played, n: -3_i64 }).to_string(), "Played image -3");
/// ```
///
/// Two or more arguments are passed by name, so a call that gives them by position, or leaves
/// one out, does not compile:
///
/// ```compile_fail,E0061
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
/// use corten::i18n::Messages as _;
///
/// let _ = Msg::for_locale("en").item_image("Pika", 12).to_string();
/// ```
///
/// ```compile_fail,E0063
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
/// use corten::i18n::Messages as _;
///
/// let _ = Msg::for_locale("en").item_image(msg::ItemImage { title: "Pika" }).to_string();
/// ```
///
/// A float is not one, since its text would be the same in every locale:
///
/// ```compile_fail,E0277
/// corten::i18n::messages! { struct Msg { "en" => "src/i18n/en.json", "fr" => "src/i18n/fr.json" } }
/// use corten::i18n::Messages as _;
///
/// let _ = Msg::for_locale("fr").item_image(msg::ItemImage { title: "Pika", n: 2.5 }).to_string();
/// ```
#[diagnostic::on_unimplemented(
    message = "`{Self}` cannot be a message argument",
    label = "not text, an integer or a value `t` formats",
    note = "pass text, an integer, or a value the locale formats (t.number(..), t.money(..), t.date(..)); a float goes through t.number(Decimal); a type of the app's own implements corten::i18n::Arg"
)]
pub trait Arg {
    /// Writes the value into the message.
    fn write_arg(&self, sink: &mut Sink<'_>);
}

impl Arg for str {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl Arg for String {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl Arg for std::borrow::Cow<'_, str> {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl Arg for char {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self.encode_utf8(&mut [0; 4]))
    }
}

impl<T: Arg + ?Sized> Arg for &T {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        (**self).write_arg(sink)
    }
}

impl Arg for Formatted {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        // The locale data has none of `<>&"` (the generator checks); a group separator `'`
        // (de-CH) is safe in text and in the double-quoted attributes `html!` writes.
        self.render(sink.out)
    }
}

impl Arg for When {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        // Locale data and digits, as for `Formatted`.
        self.render(sink.out)
    }
}

impl Arg for OnDay {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        // Locale data and digits, as for `Formatted`.
        self.render(sink.out)
    }
}

impl Arg for Relative {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        // Locale data and digits, as for `Formatted`.
        self.render(sink.out)
    }
}

impl Arg for std::sync::Arc<str> {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl Arg for std::rc::Rc<str> {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl Arg for Box<str> {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.str(self)
    }
}

impl<F: Fn(&mut Sink<'_>)> Arg for Text<F> {
    #[inline]
    fn write_arg(&self, sink: &mut Sink<'_>) {
        (self.0)(sink)
    }
}

impl<A: Args + ?Sized> Arg for Found<'_, A> {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        self.write(sink)
    }
}

macro_rules! unsigned_arg {
    ($($t:ty),*) => {$(
        impl Arg for $t {
            #[inline]
            fn write_arg(&self, sink: &mut Sink<'_>) {
                sink.integer(*self as u64)
            }
        }
    )*};
}
unsigned_arg!(u8, u16, u32, u64, usize);

macro_rules! signed_arg {
    ($($t:ty),*) => {$(
        impl Arg for $t {
            #[inline]
            fn write_arg(&self, sink: &mut Sink<'_>) {
                if *self < 0 {
                    sink.plain("-");
                }
                sink.integer(self.unsigned_abs() as u64)
            }
        }
    )*};
}
signed_arg!(i8, i16, i32, i64, isize);

impl Arg for u128 {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.display(self)
    }
}

impl Arg for i128 {
    fn write_arg(&self, sink: &mut Sink<'_>) {
        sink.display(self)
    }
}

/// A message with arguments, unfilled (`t.js().key()`): the argument a handler whose JSDoc says
/// `Message<"a" | "b">` takes, when the message's arguments are exactly `a` and `b` (`ARGS` is
/// [`crate::script::message_id`] of their names). Its text is made when the crate compiles.
/// A plural message's (`t.js().cards()`) also carries the locale's plural table and number
/// format, so the script picks the form and writes the count as the server does.
#[derive(Clone, Copy)]
pub struct Template<const ARGS: u64>(Wire);

#[derive(Clone, Copy)]
enum Wire {
    Text(&'static str),
    /// The locale, and the message's form per plural category (HTML-escaped JSON arrays), empty
    /// for a category the locale does not use.
    Plural(&'static __private::LocaleData, [&'static str; 6]),
}

impl<const ARGS: u64> Template<ARGS> {
    #[doc(hidden)]
    pub const fn new(wire: &'static str) -> Self {
        Template(Wire::Text(wire))
    }

    #[doc(hidden)]
    pub const fn plural(data: &'static __private::LocaleData, forms: [&'static str; 6]) -> Self {
        Template(Wire::Plural(data, forms))
    }

    /// The text `data-on` carries, HTML-escaped.
    pub(crate) fn write_wire(self, out: &mut String) {
        match self.0 {
            Wire::Text(wire) => out.push_str(wire),
            Wire::Plural(data, forms) => format::plural_wire(data, &forms, out),
        }
    }
}

impl<const ARGS: u64> fmt::Debug for Template<ARGS> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Not `write_wire`, which marks the page as loading the format module.
        match self.0 {
            Wire::Text(wire) => f.debug_tuple("Template").field(&wire).finish(),
            Wire::Plural(data, forms) => f.debug_tuple("Template").field(&data.tag).field(&forms).finish(),
        }
    }
}

/// The arguments of a message found by its key (`by_key`, from [`messages!`]), by name: pairs
/// (`[("count", 3)]`), a map, or a JSON object (feature `json`; a string is written without its
/// quotes, any other value as its JSON). Each is written as given, by its `Display`, since it is
/// data the app got at run time: a number in it is not in the reader's form.
pub trait Args {
    /// Calls `write` with the argument `name` and returns true, or returns false when there is none.
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool;
}

impl<K: AsRef<str>, V: Display> Args for [(K, V)] {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.iter().find(|(k, _)| k.as_ref() == name).map(|(_, v)| write(v)).is_some()
    }
}

impl<K: AsRef<str>, V: Display, const N: usize> Args for [(K, V); N] {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.as_slice().arg(name, write)
    }
}

impl<K: AsRef<str>, V: Display> Args for Vec<(K, V)> {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.as_slice().arg(name, write)
    }
}

impl<K: std::borrow::Borrow<str> + Ord, V: Display> Args for std::collections::BTreeMap<K, V> {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.get(name).map(|v| write(v)).is_some()
    }
}

impl<K: std::borrow::Borrow<str> + Eq + std::hash::Hash, V: Display, S: std::hash::BuildHasher> Args
    for std::collections::HashMap<K, V, S>
{
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.get(name).map(|v| write(v)).is_some()
    }
}

#[cfg(feature = "json")]
impl Args for serde_json::Map<String, serde_json::Value> {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        match self.get(name) {
            Some(serde_json::Value::String(text)) => write(text),
            Some(value) => write(value),
            None => return false,
        }
        true
    }
}

/// An object's members (another value has none).
#[cfg(feature = "json")]
impl Args for serde_json::Value {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        self.as_object().is_some_and(|members| members.arg(name, write))
    }
}

impl<A: Args + ?Sized> Args for &A {
    fn arg(&self, name: &str, write: &mut dyn FnMut(&dyn Display)) -> bool {
        (**self).arg(name, write)
    }
}

/// A message found by its key, with its arguments: what `by_key` returns. In `html!` it renders
/// escaped; `to_string()` gives the plain text.
pub struct Found<'a, A: ?Sized> {
    pieces: &'static [__private::Piece],
    args: &'a A,
}

impl<'a, A: Args + ?Sized> Found<'a, A> {
    /// The message, or `None` when `args` lacks one of its arguments.
    #[doc(hidden)]
    pub fn new(pieces: &'static [__private::Piece], args: &'a A) -> Option<Self> {
        let complete = pieces.iter().all(|piece| match piece {
            __private::Piece::Arg(name) => args.arg(name, &mut |_| {}),
            __private::Piece::Text(..) => true,
        });
        complete.then_some(Found { pieces, args })
    }

    fn write(&self, sink: &mut Sink<'_>) {
        for piece in self.pieces {
            match piece {
                __private::Piece::Text(plain, html) => sink.text(plain, html),
                __private::Piece::Arg(name) => {
                    self.args.arg(name, &mut |value| sink.display(value));
                }
            }
        }
    }
}

impl<A: Args + ?Sized> Render for Found<'_, A> {
    fn render(&self, out: &mut String) {
        self.write(&mut Sink { out, html: true })
    }
}

impl<A: Args + ?Sized> AttrValue for Found<'_, A> {
    fn write_attr(&self, name: &str, out: &mut String) {
        out.push_str(name);
        out.push_str("=\"");
        self.render(out);
        out.push('"');
    }
}

impl<A: Args + ?Sized> Display for Found<'_, A> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        self.write(&mut Sink { out: &mut out, html: false });
        f.write_str(&out)
    }
}

/// Used by the code `messages!` generates. Not a public API.
#[doc(hidden)]
pub mod __private {
    pub use super::format::__private::{plural, same_currencies, Field, LocaleData, Separators};
    pub use super::format::parse_money;

    /// The `count` argument of a plural message found by its key (`by_key`), without its sign:
    /// `None` when there is none or it is not a whole number. A whole number too long for a
    /// `u64` keeps its last six digits past a billion, all that its category reads.
    pub fn count<A: super::Args + ?Sized>(args: &A) -> Option<u64> {
        let mut n = None;
        args.arg("count", &mut |value| {
            let text = value.to_string();
            let digits = text.strip_prefix('-').unwrap_or(&text);
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                n = Some(
                    digits
                        .parse::<u64>()
                        .unwrap_or_else(|_| 1_000_000_000 + digits[digits.len() - 6..].parse::<u64>().unwrap_or_default()),
                );
            }
        });
        n
    }

    /// A run of a message: its text (plain and escaped) or an argument's name.
    pub enum Piece {
        Text(&'static str, &'static str),
        Arg(&'static str),
    }
}

/// A message with its arguments, from a [`messages!`] method. In `html!` it renders escaped (as
/// text or an attribute value); `to_string()` gives the plain text.
pub struct Text<F>(F);

impl<F: Fn(&mut Sink<'_>)> Text<F> {
    #[doc(hidden)]
    pub fn new(write: F) -> Self {
        Text(write)
    }
}

impl<F: Fn(&mut Sink<'_>)> Render for Text<F> {
    #[inline]
    fn render(&self, out: &mut String) {
        (self.0)(&mut Sink { out, html: true })
    }
}

impl<F: Fn(&mut Sink<'_>)> AttrValue for Text<F> {
    fn write_attr(&self, name: &str, out: &mut String) {
        out.push_str(name);
        out.push_str("=\"");
        self.render(out);
        out.push('"');
    }
}

impl<F: Fn(&mut Sink<'_>)> Display for Text<F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut out = String::new();
        (self.0)(&mut Sink { out: &mut out, html: false });
        f.write_str(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plural with arguments besides its count takes them by name, the count as `count`.
    #[test]
    fn a_plural_with_more_arguments_takes_them_by_name() {
        crate::i18n::messages! { struct CartMsg { "en" => "src/i18n/en-plural-args.json" } }
        let en = CartMsg::for_locale("en");
        let one =
            en.cart_lines(cart_msg::CartLines { count: 1, cart: "Main", total: en.money(Minor(1250), Currency::new("USD")) });
        assert_eq!(one.to_string(), "1 line in Main ($12.50)");
        let many = en.cart_lines(cart_msg::CartLines { total: "$0", cart: "<Spare>", count: 1200_u32 });
        assert_eq!(many.to_html(), "1,200 lines in &lt;Spare&gt; ($0)");
    }

    /// A day parses as `YYYY-MM-DD` only, writes back the same, and is written as that day.
    #[test]
    fn a_day_is_its_calendar_date_in_every_zone() {
        let day: Day = "2026-09-02".parse().unwrap();
        assert_eq!((day.year(), day.month(), day.day()), (2026, 9, 2));
        assert_eq!(day.to_string(), "2026-09-02");
        assert_eq!(Day::new(2024, 2, 29).map(|d| d.to_string()).as_deref(), Some("2024-02-29"));
        for text in [
            "2026-9-2",
            "2026-09-02T00:00:00Z",
            "2026-02-30",
            "2025-02-29",
            "1900-02-29",
            "2026-13-01",
            "2026-00-10",
            "+026-09-02",
            " 2026-09-02",
            "2026/09/02",
            "0000-01-01",
            "",
        ] {
            assert_eq!(text.parse::<Day>(), Err(InvalidDay), "{text:?}");
        }
        assert_eq!("2000-02-29".parse::<Day>().map(|d| d.day()), Ok(29));
        assert_eq!(day.plus(29).map(|d| d.to_string()).as_deref(), Some("2026-10-01"));
        assert_eq!(day.plus(-245).map(|d| d.to_string()).as_deref(), Some("2025-12-31"));
        assert_eq!(Day::new(9999, 12, 31).unwrap().plus(1), None);
        assert_eq!(
            Day::new(1969, 12, 31).unwrap().midnight_utc(),
            Some(std::time::UNIX_EPOCH - std::time::Duration::from_secs(86_400))
        );
        assert!(Day::new(2026, 9, 1).unwrap() < day);
        let en = Msg::for_locale("en");
        assert_eq!(en.date(day, DateStyle::Medium).to_string(), "Sep 2, 2026");
        assert_eq!(en.date(day, DayStyle::Short).to_string(), "Sep 2");
        assert_eq!(en.date(day, MonthStyle::Long).to_string(), "September 2026");
        assert_eq!(en.date(day, DateStyle::Medium).datetime().to_string(), "2026-09-02");
        // An instant at the same midnight is still an instant, in the zone it is given.
        assert_eq!(en.date(day.midnight_utc().unwrap(), DateStyle::Medium).zone(Offset::hours(-5)).to_string(), "Sep 1, 2026");
        // Every day is written from its calendar date, before the earliest instant a platform has
        // too (1601 on Windows).
        for (text, written) in [
            ("0001-01-01", "Jan 1, 1"),
            ("1600-02-29", "Feb 29, 1600"),
            ("1600-12-31", "Dec 31, 1600"),
            ("9999-12-31", "Dec 31, 9999"),
        ] {
            assert_eq!(en.date(text.parse::<Day>().unwrap(), DateStyle::Medium).to_string(), written, "{text}");
        }
    }

    #[cfg(feature = "json")]
    #[test]
    fn a_day_is_its_text_in_json() {
        let day = Day::new(2026, 9, 2).unwrap();
        assert_eq!(crate::json::to_vec(&day), br#""2026-09-02""#);
        assert_eq!(crate::json::from_str::<Day>(r#""2026-09-02""#).unwrap(), day);
        assert!(crate::json::from_str::<Day>(r#""2026-09-31""#).is_err());
        assert_eq!(serde_json::to_string(&day).unwrap(), r#""2026-09-02""#);
        assert_eq!(serde_json::from_str::<Day>(r#""2026-09-02""#).unwrap(), day);
    }

    /// A code given in lower case finds the currency's symbol and digits, as its upper case does.
    #[test]
    fn a_lower_case_code_finds_its_symbol() {
        let en = Msg::for_locale("en");
        assert_eq!(en.money(Minor(150), Currency::parse("usd").unwrap()).to_string(), "$1.50");
        assert_eq!(en.money(Minor(150), Currency::parse("jpy").unwrap()).to_string(), "¥150");
        assert_eq!((Currency::parse("kwd").unwrap().digits(), Currency::parse("zzz").unwrap().digits()), (3, 2));
    }

    /// Money typed in a locale is read back in minor units, as `t.money` writes it.
    #[test]
    fn money_is_read_back_as_the_locale_writes_it() {
        let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
        let usd = Currency::new("USD");
        let read = |t: Msg, text: &str| t.parse_money(text, usd).map(|m| m.0);
        for (text, cents) in [
            ("$1,299.50", 129950),
            ("1299.5", 129950),
            (" 1,299 ", 129900),
            (".5", 50),
            ("0.05", 5),
            ("USD 12", 1200),
            ("12 USD", 1200),
            ("1,234,567.89", 123456789),
            ("$ 7", 700),
        ] {
            assert_eq!(read(en, text), Some(cents), "en {text:?}");
        }
        for text in [
            "",
            "$",
            "-1",
            "+1",
            "1,2,3",
            "12,34",
            "1,2345",
            ",123",
            "1.234",
            "12.",
            "1e3",
            "12.50.1",
            "18446744073709551616",
            "$$12",
            "12$",
            "1,23,456",
            "1234,567",
            "1,234,56",
            "1 234",
        ] {
            assert_eq!(read(en, text), None, "en {text:?}");
        }
        for (text, cents) in [
            ("12,50", 1250),
            ("1\u{202f}299,50\u{a0}$US", 129950),
            ("1 299,50 $US", 129950),
            ("1299", 129900),
            ("12,5 USD", 1250),
        ] {
            assert_eq!(read(fr, text), Some(cents), "fr {text:?}");
        }
        for text in ["12.50", "1,299.50", "1 29,50"] {
            assert_eq!(read(fr, text), None, "fr {text:?}: another locale's form");
        }
        let jpy = Currency::new("JPY");
        assert_eq!(en.parse_money("¥1,234", jpy).map(|m| m.0), Some(1234));
        assert_eq!(en.parse_money("1,234.5", jpy), None, "yen has no fraction");
        // What `t.money` writes reads back.
        for cents in [0_u64, 5, 99, 100, 1234, 129950, 100_000_000, 987_654_321_012] {
            for t in [en, fr] {
                let text = t.money(Minor(cents), usd).to_string();
                assert_eq!(read(t, &text), Some(cents), "{} {text:?}", t.locale());
            }
        }
    }

    /// An integer argument writes what its `Display` writes, in a page and as text.
    #[test]
    fn integer_arguments_write_their_digits() {
        fn both<T: Arg + Display>(n: T) {
            let mut out = String::new();
            n.write_arg(&mut Sink { out: &mut out, html: true });
            assert_eq!(out, n.to_string());
            out.clear();
            n.write_arg(&mut Sink { out: &mut out, html: false });
            assert_eq!(out, n.to_string());
        }
        macro_rules! each {
            ($($t:ty),*) => {$(
                for n in [<$t>::MIN, <$t>::MAX, 0, 1, 9, 10, 99, 100] { both(n); }
                both(<$t>::MAX / 3);
            )*};
        }
        each!(u8, u16, u32, u64, usize, u128, i8, i16, i32, i64, isize, i128);
        for n in [-1_i64, -9, -10, -1234567] {
            both(n);
        }
    }

    /// The month styles, by their index in the cases after the other 14, and the day styles after
    /// them.
    const MONTHS: [MonthStyle; 2] = [MonthStyle::Short, MonthStyle::Long];
    const DAYS: [DayStyle; 2] = [DayStyle::Short, DayStyle::Long];

    crate::i18n::messages! {
        /// The test catalogs.
        struct Msg {
            "en" => "src/i18n/en.json",
            "fr" => "src/i18n/fr.json",
        }
    }

    mod url_locale {
        use crate::{i18n::Locale, prelude::*, App, Params};

        crate::i18n::messages! {
            /// The test catalogs, for a route field.
            pub struct Msg {
                "en" => "src/i18n/en.json",
                "fr" => "src/i18n/fr.json",
            }
        }

        crate::i18n::messages! {
            /// The same catalogs listed in another order: a second messages type.
            pub struct Other {
                "fr" => "src/i18n/fr.json",
                "en" => "src/i18n/en.json",
            }
        }

        #[crate::routes]
        mod url {
            #[route("/{lang}/listings", get = listings)]
            pub struct Listings {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/listings", get = negotiated)]
            pub struct Negotiated;

            #[route("/{lang}/other", get = other)]
            pub struct OtherPage {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/{lang}/failing", get = failing)]
            pub struct Failing {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/{lang}/late", get = late)]
            pub struct Late {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/{lang}/other-first", get = other_first)]
            pub struct OtherFirst {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/{lang}/twice", get = twice)]
            pub struct Twice {
                pub lang: crate::i18n::Locale<super::Msg>,
            }

            #[route("/{lang}/mixed", get = mixed)]
            pub struct Mixed {
                pub lang: crate::i18n::Locale<super::Msg>,
            }
        }

        fn page(req: &Req) -> HtmlResult {
            let (t, lang): (Msg, _) = (req.t(), req.lang());
            req.page(html! {
                <html lang={lang}>
                    <head>
                        <title>"Listings"</title>
                        <Corten />
                    </head>
                    <body><main>{t.item_listings()}</main></body>
                </html>
            })
        }

        async fn listings(req: Req, Params(at): Params<url::Listings>) -> HtmlResult {
            req.set_locale(at.lang);
            page(&req)
        }

        async fn negotiated(req: Req) -> HtmlResult {
            page(&req)
        }

        /// A second messages type follows the URL's locale by its tag, not by the app's index.
        async fn other(req: Req, Params(at): Params<url::OtherPage>) -> String {
            req.set_locale(at.lang);
            let t: Other = req.t();
            t.item_listings().to_string()
        }

        async fn failing(req: Req, Params(at): Params<url::Failing>) -> HtmlResult {
            req.set_locale(at.lang);
            Err(crate::Error::new("down"))
        }

        /// Reads the locale through a second messages type, then sets it.
        async fn other_first(req: Req, Params(at): Params<url::OtherFirst>) -> HtmlResult {
            let _: Other = req.t();
            req.set_locale(at.lang);
            page(&req)
        }

        /// Reads the locale through two messages types, which may give two languages, then sets it.
        async fn mixed(req: Req, Params(at): Params<url::Mixed>) -> HtmlResult {
            let _: Other = req.t();
            let _ = req.lang();
            req.set_locale(at.lang);
            page(&req)
        }

        /// Sets one locale, then another, before anything reads it: the last one stands.
        async fn twice(req: Req, Params(at): Params<url::Twice>) -> HtmlResult {
            req.set_locale(Locale::of(Msg::for_locale("en")));
            req.set_locale(at.lang);
            page(&req)
        }

        /// Reads the locale, then sets another: a bug a debug build stops.
        async fn late(req: Req, Params(at): Params<url::Late>) -> HtmlResult {
            let _: Msg = req.t();
            req.set_locale(at.lang);
            page(&req)
        }

        fn header<'a>(res: &'a crate::testing::Answer, name: &str) -> &'a str {
            res.headers().get(name).map_or("", |v| v.to_str().unwrap())
        }

        /// A page whose locale is in its URL is that locale whatever `Accept-Language` asks, says
        /// so in `Content-Language`, and does not vary on `Accept-Language`, so a cache keys it on
        /// the URL; one negotiated still varies on it. Pages in two locales have two shell keys.
        #[tokio::test]
        async fn a_locale_in_the_url_is_the_page_s_and_its_cache_key() {
            let app = App::new(url::router()).messages::<Msg>().test();
            let fr = Locale::of(Msg::for_locale("fr"));
            let en = Locale::of(Msg::for_locale("en"));
            let page = app.get(&url::Listings { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert!(
                page.text().contains(r#"<html lang="fr">"#) && page.text().contains("<main>Annonces</main>"),
                "{}",
                page.text()
            );
            assert_eq!(header(&page, "content-language"), "fr");
            assert_eq!(header(&page, "vary"), "corten, accept");
            let other = app.get(&url::Listings { lang: en }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert!(other.text().contains("<main>Listings</main>"), "{}", other.text());
            assert_ne!(header(&page, "corten-shell"), header(&other, "corten-shell"), "another locale, another layout");
            let asked = app.get(&url::Negotiated).header(http::header::ACCEPT_LANGUAGE, "fr-CA").await;
            assert!(asked.text().contains("<main>Annonces</main>"), "{}", asked.text());
            assert_eq!(header(&asked, "content-language"), "fr");
            assert_eq!(header(&asked, "vary"), "corten, accept, accept-language");
            let none = app.get(&crate::route::Local::parse("/de/listings").unwrap()).await;
            assert_eq!(
                none.status(),
                http::StatusCode::BAD_REQUEST,
                "not one of the app's locales: a parameter that does not read"
            );
            let upper = app.get(&crate::route::Local::parse("/FR/listings").unwrap()).await;
            assert_eq!(upper.status(), http::StatusCode::BAD_REQUEST, "one URL per locale");
            let other = app.get(&url::OtherPage { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert_eq!(other.text(), "Annonces", "a second messages type, listed in another order");
            let failed = app.get(&url::Failing { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert_eq!(failed.status(), http::StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(header(&failed, "content-language"), "fr", "the error page follows the URL's locale");
            assert!(failed.text().contains(r#"<html lang="fr""#), "{}", failed.text());
            assert_eq!(header(&failed, "vary"), "corten, accept");
        }

        /// Setting the locale after reading one would label the page in one language and draw it in
        /// another; a debug build stops it.
        #[cfg(debug_assertions)]
        #[tokio::test]
        async fn a_locale_set_after_one_was_read_is_a_bug() {
            let app = App::new(url::router()).messages::<Msg>().test();
            let fr = Locale::of(Msg::for_locale("fr"));
            let late = app.get(&url::Late { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert_eq!(late.status(), http::StatusCode::INTERNAL_SERVER_ERROR, "a panic: {}", late.text());
            let same = app
                .get(&url::Late { lang: Locale::of(Msg::for_locale("en")) })
                .header(http::header::ACCEPT_LANGUAGE, "en-US")
                .await;
            assert_eq!(same.status(), http::StatusCode::OK, "the locale it read: nothing changes");
            let other = app.get(&url::OtherFirst { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert_eq!(other.status(), http::StatusCode::INTERNAL_SERVER_ERROR, "read through another messages type");
            // Read through another messages type in the URL's language: nothing changes.
            let other_same = app.get(&url::OtherFirst { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "fr-FR").await;
            assert_eq!(other_same.status(), http::StatusCode::OK, "{}", other_same.text());
            let en = Locale::of(Msg::for_locale("en"));
            let other_en = app.get(&url::OtherFirst { lang: en }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert_eq!(other_en.status(), http::StatusCode::OK, "{}", other_en.text());
            // Each read in the URL's language: nothing changes. Two reads in different languages
            // (no header: each type's own default): one of them is not the URL's.
            let both = app.get(&url::Mixed { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "fr-FR").await;
            assert_eq!(both.status(), http::StatusCode::OK, "{}", both.text());
            let split = app.get(&url::Mixed { lang: fr }).await;
            assert_eq!(split.status(), http::StatusCode::INTERNAL_SERVER_ERROR, "{}", split.text());
            let twice = app.get(&url::Twice { lang: fr }).header(http::header::ACCEPT_LANGUAGE, "en-US").await;
            assert!(twice.text().contains("<main>Annonces</main>"), "set twice, read once: {}", twice.text());
        }
    }

    #[test]
    fn messages_are_methods_with_typed_arguments() {
        let en = Msg::negotiate(Some("en-US"));
        let fr = Msg::negotiate(Some("fr-CA, en;q=0.5"));
        assert_eq!((en.locale(), fr.locale()), ("en", "fr"));
        assert_eq!(en.item_listings(), "Listings");
        assert_eq!(fr.item_listings(), "Annonces");
        assert_eq!(en.item_listing_count(3).to_string(), "3 listings");
        // Past 2^53, where a browser's number is no longer exact, the category is still the count's.
        assert!(fr.item_listing_count(1_000_000_000_000_000_000u64).to_string().ends_with(" d’annonces"));
        assert!(fr.item_listing_count(1_000_000_000_000_000_001u64).to_string().ends_with(" annonces"));
        assert!(fr.item_listing_count(-1i64).to_string().ends_with("1 annonce"), "a negative count by its size");
        assert!(fr.item_listing_count(u128::MAX).to_string().ends_with(" annonces"), "...211455 is other");
        assert!(fr.item_listing_count(10u128.pow(30)).to_string().ends_with(" d’annonces"), "a multiple of a million");
        assert!(fr.item_listing_count(i128::MIN).to_string().ends_with(" annonces"), "...105728 is other");
        // by_key takes a whole number of any length (u128, or digits from JSON).
        let huge = |count: &str| fr.by_key("item.listing_count", &[("count", count)]).map(|t| t.to_string());
        assert_eq!(huge("1000000000000000000000000").as_deref(), Some("1000000000000000000000000 d’annonces"));
        assert_eq!(huge("-18446744073709551617").as_deref(), Some("-18446744073709551617 annonces"));
        assert_eq!(huge("1.5"), None, "not a whole number");
        assert_eq!(
            fr.by_key("item.listing_count", &[("count", u128::MAX)]).map(|t| t.to_string().ends_with(" annonces")),
            Some(true)
        );
        assert_eq!(
            fr.item_image(msg::ItemImage { title: "<Pika>", n: 2 }).to_string(),
            "Image 2 de <Pika>",
            "arguments may be in another order"
        );
        assert_eq!(
            en.item_image(msg::ItemImage { title: "<Pika>", n: 2 }).to_html(),
            "&lt;Pika&gt; image 2",
            "escaped in a page"
        );
        assert_eq!(en.brace().to_html(), "{literal} &amp; more", "the message's own text is escaped too");
        let view = crate::html! {
            <img alt={fr.item_image(msg::ItemImage { title: "A & B", n: 1 })}>
            <p>{en.item_listing_count(1)}</p>
        };
        assert_eq!(view.to_html(), r#"<img alt="Image 1 de A &amp; B"><p>1 listing</p>"#);
        assert_eq!(Msg::for_locale("FR"), fr);
        assert_eq!(Msg::default().locale(), "en");
        // Arguments named like Rust keywords are raw parameters; the catalog keeps its names.
        let confidence: Decimal = "0.9".parse().unwrap();
        assert_eq!(
            en.attention_detail(msg::AttentionDetail { provider: "TCGplayer", r#type: "alias", r#match: en.number(confidence) })
                .to_string(),
            "TCGplayer · alias · confidence 0.9"
        );
        assert_eq!(
            fr.attention_detail(msg::AttentionDetail { provider: "P", r#type: "alias", r#match: fr.number(confidence) })
                .to_string(),
            "P · alias · confiance 0,9"
        );
        let by_key = fr.by_key("attention.detail", &[("provider", "P"), ("type", "alias"), ("match", "1")]);
        assert_eq!(by_key.unwrap().to_string(), "P · alias · confiance 1");
        // camelCase arguments: snake case parameters, the catalog's names by key.
        assert_eq!(
            en.attention_updated(msg::AttentionUpdated { updated_at: "today", item_title: "<Pika>" }).to_html(),
            "Updated today by &lt;Pika&gt;"
        );
        let params = [("updatedAt", "hier"), ("itemTitle", "Pika")];
        assert_eq!(fr.by_key("attention.updated", &params).unwrap().to_string(), "Mis à jour hier par Pika");
        assert!(fr.by_key("attention.updated", &[("updated_at", "x"), ("item_title", "y")]).is_none(), "by the catalog's names");
    }

    #[test]
    fn a_message_is_found_by_its_catalog_key_with_named_arguments() {
        let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
        let args = [("title", "<Pika>"), ("n", "2")];
        assert_eq!(en.by_key("item.image", &args).unwrap().to_html(), "&lt;Pika&gt; image 2", "escaped in a page");
        assert_eq!(fr.by_key("item.image", &args).unwrap().to_string(), "Image 2 de <Pika>");
        assert_eq!(en.by_key("item.listings", &[("unused", 1)]).unwrap().to_string(), "Listings", "no arguments");
        assert_eq!(en.by_key("brace", &[("x", 0)]).unwrap().to_html(), "{literal} &amp; more");
        assert!(en.by_key("item_listings", &args).is_none(), "the catalog key, not the method name");
        assert!(en.by_key("item.listing_count", &[("total", 3)]).is_none(), "an argument is missing");
        let mut map = std::collections::HashMap::new();
        map.insert("count".to_string(), 3);
        assert_eq!(fr.by_key("item.listing_count", &map).unwrap().to_string(), "3 annonces");
        #[cfg(feature = "json")]
        {
            let answer: serde_json::Value = serde_json::from_str(r#"{"titleParams":{"title":"A & B","n":4}}"#).unwrap();
            let view = crate::html! { <p>{en.by_key("item.image", &answer["titleParams"])}</p> };
            assert_eq!(view.to_html(), "<p>A &amp; B image 4</p>", "a JSON string without quotes, a number as written");
        }
    }

    /// `t.percent` takes a ratio, rounds to the digits asked for and drops trailing zeros; a
    /// basis-point rate is `Decimal::new(bps, 4)`.
    #[test]
    fn a_ratio_is_written_as_the_locale_writes_a_percentage() {
        let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
        let fee = Decimal::new(290, 4);
        assert_eq!(en.percent(fee, 2).to_string(), "2.9%");
        assert_eq!(fr.percent(fee, 2).to_string(), "2,9\u{a0}%");
        assert_eq!(en.percent(Decimal::new(1, 3), 0).to_string(), "0%");
        assert_eq!(en.percent(Decimal::new(-125, 5), 2).to_string(), "-0.13%", "half away from zero");
        assert_eq!(en.percent(12, 2).to_string(), "1,200%", "an integer is a ratio too");
        assert_eq!(
            crate::html! { <td title={en.percent(fee, 1)}>{fr.percent(fee, 1)}</td> }.to_html(),
            "<td title=\"2.9%\">2,9\u{a0}%</td>"
        );
    }

    /// `t.change` writes a change for a column that lines up: always its digits, a sign on a gain
    /// as on a loss, and none on what rounds to zero.
    #[test]
    fn a_change_has_its_digits_and_a_sign() {
        let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
        assert_eq!(en.change(Decimal::new(60, 4), 2).to_string(), "+0.60%");
        assert_eq!(en.change(Decimal::new(-30, 4), 2).to_string(), "-0.30%");
        assert_eq!(en.change(Decimal::new(-4, 5), 2).to_string(), "0.00%", "rounds to zero: no sign");
        assert_eq!(en.change(0, 1).to_string(), "0.0%");
        let many = format!("+0.6{}%", "0".repeat(36));
        assert_eq!(en.change(Decimal::new(6, 3), 40).to_string(), many, "at most 38 digits in all");
        assert_eq!(en.change(Decimal::new(12_345, 3), 255).to_string().len(), "+1,234.".len() + 34 + 1);
        assert_eq!(en.change(Decimal::new(125, 5), 2).to_string(), "+0.13%", "half away from zero");
        assert_eq!(fr.change(Decimal::new(60, 4), 2).to_string(), "+0,60\u{a0}%", "the locale's sign in place");
    }

    /// A value past `u64` is written digit for digit, as one that fits is.
    #[test]
    fn a_value_past_u64_keeps_every_digit() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        let en = locales.iter().find(|(t, _)| *t == "en").unwrap().1;
        let max = Decimal::new(i128::MAX, 0);
        assert_eq!(max.to_string(), "170141183460469231731687303715884105727");
        assert_eq!(Decimal::new(i128::MAX, 38).to_string(), "1.70141183460469231731687303715884105727");
        assert_eq!(Decimal::new(i128::MIN + 1, 2).to_string(), "-1701411834604692317316873037158841057.27");
        assert_eq!(Formatted::number(en, max).to_string(), "170,141,183,460,469,231,731,687,303,715,884,105,727");
        let past = Decimal::new(i128::from(u64::MAX) + 1, 0);
        assert_eq!(Formatted::number(en, past).to_string(), "18,446,744,073,709,551,616");
        assert_eq!(
            Formatted::money(en, &Minor(u128::from(u64::MAX) + 1), Currency::new("USD")).to_string(),
            "$184,467,440,737,095,516.16"
        );
    }

    /// The code a locale table's key is for (`Currency::key`: the code's three bytes).
    fn code_of(key: u32) -> String {
        let [zero, code @ ..] = key.to_be_bytes();
        assert_eq!(zero, 0, "{key}");
        String::from_utf8(code.to_vec()).unwrap()
    }

    /// `t.money` places a code only in the template that writes a currency by its code; every
    /// currency a locale has a symbol for has it in place. Each table's keys are well formed (three
    /// upper-case letters, as `Currency` keys them) and in order; that a key is its row's
    /// currency is checked by the cases Intl wrote, in every locale.
    #[test]
    fn a_currency_with_a_symbol_has_no_code_to_place() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        for (tag, data) in locales {
            for (key, positive, negative) in data.currencies {
                let code = code_of(*key);
                assert!(!positive.contains('\u{2}') && !negative.contains('\u{2}'), "{tag} {code}");
                assert_eq!(Currency::parse(&code).map(|c| c.key()), Some(*key), "{tag} {code}");
            }
            assert!(data.currencies.is_sorted_by_key(|(key, ..)| *key), "{tag}");
        }
    }

    /// A currency's slot, found once when it is made, leads each locale to the row with its symbol
    /// and to none where the locale writes it by its code: every row is found by its own currency,
    /// every currency with a symbol anywhere is tried in every locale, and so is one with none.
    #[test]
    fn each_currency_finds_its_own_row_in_every_locale() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        let with_symbol = super::display_digits::SYMBOL_CURRENCIES;
        for (tag, data) in locales {
            assert_eq!(data.slots.len(), with_symbol.len(), "{tag}");
            for key in with_symbol.iter().copied().chain([u32::from_be_bytes([0, b'X', b'Y', b'Z'])]) {
                let code = code_of(key);
                let currency = Currency::parse(&code).unwrap();
                let own = data.currencies.iter().find(|(k, ..)| *k == key);
                assert_eq!(format::symbol(data, currency), own, "{tag} {code}");
            }
            for (key, ..) in data.currencies {
                assert!(with_symbol.contains(key), "{tag} {}", code_of(*key));
            }
        }
    }

    /// Locale data from another release's `corten-macros` does not build: its list of currencies
    /// with a symbol must be this one, item by item, not only as long.
    #[test]
    fn locale_data_indexes_this_releases_currencies() {
        let ours = super::display_digits::SYMBOL_CURRENCIES;
        assert!(format::__private::is_ours(ours));
        let mut moved = ours.to_vec();
        moved[ours.len() / 2] += 1;
        assert!(!format::__private::is_ours(&moved));
        assert!(!format::__private::is_ours(&ours[1..]));
    }

    /// Every amount every locale writes (Intl's, in cases.tsv, and ours in every currency its data
    /// has) reads back, and what people type for it without the marks Intl adds: a symbol's
    /// direction marks, its no-break spaces.
    #[test]
    fn every_locale_reads_back_the_money_it_writes() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        let data = |tag: &str| locales.iter().find(|(t, _)| *t == tag).expect(tag).1;
        let mut checked = 0;
        for line in include_str!("i18n/cases.tsv").lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
            let cols: Vec<&str> = line.split('\t').collect();
            let (tag, kind, input, expected) = (cols[0], cols[1], cols[2], cols[3]);
            let Some((amount, code)) = input.split_once(' ').filter(|_| kind == "money") else { continue };
            if amount.starts_with('-') {
                continue;
            }
            let currency = Currency::parse(code).unwrap();
            // The amount in minor units, as written: rounded half away from zero to the currency's digits.
            let shown = usize::from(currency.digits());
            let (whole, fraction) = amount.split_once('.').unwrap_or((amount, ""));
            let kept: String = fraction.chars().chain(std::iter::repeat('0')).take(shown).collect();
            let up = fraction.chars().nth(shown).is_some_and(|d| d >= '5');
            let minor = Minor(format!("{whole}{kept}").parse::<u64>().unwrap() + u64::from(up));
            let typed: String = expected.chars().filter(|c| !matches!(c, '\u{200e}' | '\u{200f}' | '\u{61c}')).collect();
            let typed = typed.replace(['\u{a0}', '\u{202f}'], " ");
            for text in [expected, &typed] {
                assert_eq!(format::parse_money(data(tag), text, currency), Some(minor), "{tag} {input} {text:?}");
            }
            checked += 1;
        }
        assert!(checked > 1000, "{checked}");
        // Every currency a locale has a symbol for, not only the ones in cases.tsv: a longer symbol
        // in a later CLDR still reads.
        for (tag, data) in locales {
            for (key, ..) in data.currencies {
                let code = code_of(*key);
                let currency = Currency::parse(&code).unwrap();
                for minor in [0_u64, 7, 1234, 123_456_789] {
                    let text = Formatted::money(data, &Minor(minor), currency).to_string();
                    assert_eq!(format::parse_money(data, &text, currency), Some(Minor(minor)), "{tag} {code} {text:?}");
                }
            }
        }
        let read =
            |tag: &str, text: &str, code: &str| format::parse_money(data(tag), text, Currency::parse(code).unwrap()).map(|m| m.0);
        // Typed as people type them: no marks, ASCII or the locale's digits, either case.
        assert_eq!(read("he", "12.50 ₪", "ILS"), Some(1250));
        assert_eq!(read("fa", "$۱۲٫۵۰", "USD"), Some(1250));
        assert_eq!(read("ar-EG", "12.50", "USD"), Some(1250));
        assert_eq!(read("ar", "21.505 د.ك.", "KWD"), Some(21505));
        assert_eq!(read("fr-CA", "21,51 $ US", "USD"), Some(2151));
        assert_eq!(read("fr-CA", "21,51 $US", "USD"), Some(2151));
        assert_eq!(read("ja", "¥1,234", "JPY"), Some(1234));
        assert_eq!(read("en", "usd 12", "USD"), Some(1200));
        // A decimal comma of another locale is not a group.
        for text in ["0,500", "0,123", "00,123", "1\t234"] {
            assert_eq!(read("en", text, "KWD"), None, "{text:?}");
        }
    }

    /// `render` writes what `write` (`to_string`) does: the short path (a symbol's money and a
    /// number under 1,000 with at most two fraction digits) and the rest, in every locale; and
    /// every template the short path splits has one place for the digits.
    #[test]
    fn rendering_writes_what_display_does_in_every_locale() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        // `1 << 32` and above: a mantissa whose low 32 bits alone would pass for a short one.
        let mantissas = [
            0i128,
            1,
            5,
            9,
            10,
            27,
            99,
            100,
            101,
            999,
            1000,
            9999,
            12345,
            99_999,
            100_000,
            123_456_789,
            1 << 32,
            (1 << 32) + 1234,
            i128::from(u64::MAX),
        ];
        let mut checked = 0;
        for (tag, data) in locales {
            let mut values: Vec<Formatted> = Vec::new();
            for code in ["USD", "EUR", "JPY", "KWD", "CHF", "INR", "GBP", "XXX", "BRL"] {
                let currency = Currency::parse(code).unwrap();
                for &n in &mantissas {
                    for n in [n, -n] {
                        values.push(Formatted::money(data, &Minor(n), currency));
                        values.push(Formatted::signed_money(data, &Minor(n), currency));
                    }
                }
            }
            for &n in &mantissas {
                for scale in [0u8, 1, 2, 3] {
                    for n in [n, -n] {
                        values.push(Formatted::number(data, Decimal::new(n, scale)));
                        values.push(Formatted::percent(data, Decimal::new(n, scale), 1));
                    }
                }
            }
            // Negative zero (as parsed, or an amount that rounds to it) takes the loss's template.
            let usd = Currency::parse("USD").unwrap();
            for text in ["-0", "-0.0", "-0.00"] {
                values.push(Formatted::number(data, Decimal::parse(text).unwrap()));
                values.push(Formatted::money(data, &Decimal::parse(text).unwrap(), usd));
            }
            values.push(Formatted::money(data, &Decimal::parse("-0.001").unwrap(), usd));
            values.push(Formatted::change(data, Decimal::parse("0.0123").unwrap(), 1));
            // One place for the digits in every symbol template and number template, which the
            // short path assumes.
            for &(key, positive, loss) in data.currencies {
                assert!([positive, loss].iter().all(|t| t.matches('\u{1}').count() == 1), "{tag} {}", code_of(key));
            }
            assert!(data.number.iter().all(|t| t.matches('\u{1}').count() == 1), "{tag}");
            for v in &values {
                let mut rendered = String::new();
                crate::view::Render::render(v, &mut rendered);
                assert_eq!(rendered, v.to_string(), "{tag}");
                checked += 1;
            }
        }
        assert!(checked > 50_000, "{checked}");
    }

    /// Every case `scripts/locale-data.mjs` had Intl write, for every locale: numbers, money and
    /// dates in fixed zones.
    #[test]
    fn every_locale_writes_numbers_money_and_dates_as_intl_does() {
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        let rendered = |f: Formatted, expected: &str, line: &str| {
            let mut out = String::new();
            crate::view::Render::render(&f, &mut out);
            assert_eq!(out, expected, "rendered: {line}");
            f.to_string()
        };
        let mut checked = 0;
        for line in include_str!("i18n/cases.tsv").lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
            let mut cols = line.split('\t');
            let (tag, kind, input, expected) =
                (cols.next().unwrap(), cols.next().unwrap(), cols.next().unwrap(), cols.next().unwrap());
            let data = locales.iter().find(|(t, _)| *t == tag).expect(tag).1;
            let ours = match kind.split(' ').collect::<Vec<_>>()[..] {
                // A number and money are also rendered, as `html!` writes them (its short path).
                ["number"] => rendered(Formatted::number(data, Decimal::parse(input).unwrap()), expected, line),
                ["percent", digits] => {
                    Formatted::percent(data, Decimal::parse(input).unwrap(), digits.parse().unwrap()).to_string()
                }
                ["change", digits] => {
                    Formatted::change(data, Decimal::parse(input).unwrap(), digits.parse().unwrap()).to_string()
                }
                ["money"] => {
                    let (amount, code) = input.split_once(' ').unwrap();
                    rendered(
                        Formatted::money(data, &Decimal::parse(amount).unwrap(), Currency::parse(code).unwrap()),
                        expected,
                        line,
                    )
                }
                ["signed_money"] => {
                    let (amount, code) = input.split_once(' ').unwrap();
                    Formatted::signed_money(data, &Decimal::parse(amount).unwrap(), Currency::parse(code).unwrap()).to_string()
                }
                ["date", style, ref offset @ ..] => {
                    let at = parse_timestamp(input).unwrap();
                    let style: u8 = style.parse().unwrap();
                    let styles = [DateStyle::Short, DateStyle::Medium, DateStyle::Long, DateStyle::Full];
                    let times = [TimeStyle::Short, TimeStyle::Medium];
                    let when = match style {
                        0..=3 => When::date(data, at, styles[style as usize]),
                        4..=11 => When::date_time(data, at, styles[(style as usize - 4) / 2], times[(style as usize - 4) % 2]),
                        12..=13 => When::time(data, at, times[style as usize - 12]),
                        14..=15 => When::date(data, at, MONTHS[style as usize - 14]),
                        _ => When::date(data, at, DAYS[style as usize - 16]),
                    };
                    let offset = offset.first().map_or(0, |o| o.parse().unwrap());
                    when.zone(Offset::seconds(offset)).to_string()
                }
                ["relative", style] => {
                    let style =
                        [RelativeStyle::Long, RelativeStyle::Short, RelativeStyle::Narrow][style.parse::<usize>().unwrap()];
                    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1 << 32);
                    let seconds: i64 = input.parse().unwrap();
                    let by = std::time::Duration::from_secs(seconds.unsigned_abs());
                    let at = if seconds < 0 { now - by } else { now + by };
                    Relative::new(data, at, now, style).to_string()
                }
                _ => panic!("{line}"),
            };
            assert_eq!(ours, expected, "{tag} {kind} {input}");
            checked += 1;
        }
        assert!(checked > 9000, "{checked}");
    }

    /// `<time datetime>`: to the millisecond where there is one, rounded down before 1970 too.
    #[test]
    fn a_relative_time_says_its_instant_to_the_millisecond() {
        use std::time::{Duration, UNIX_EPOCH};
        let data = corten_macros::__all_locales!().iter().find(|(t, _)| *t == "en").unwrap().1;
        let now = UNIX_EPOCH + Duration::from_secs(1_774_191_845);
        let at = |t| Relative::new(data, t, now, RelativeStyle::Narrow).datetime().to_string();
        assert_eq!(at(now), "2026-03-22T15:04:05Z");
        assert_eq!(at(now + Duration::from_millis(250)), "2026-03-22T15:04:05.250Z");
        assert_eq!(at(UNIX_EPOCH - Duration::from_micros(1)), "1969-12-31T23:59:59.999Z");
        assert_eq!(Relative::new(data, now, now, RelativeStyle::Long).to_string(), "0 seconds ago");
        assert_eq!(Relative::new(data, now + Duration::from_secs(38_100), now, RelativeStyle::Narrow).to_string(), "in 10h");
    }

    /// The format each case's page would send a script (`t.js().number()`, `.money(..)`,
    /// `.date(..)`), by locale: `scripts/format.mjs` runs `crates/corten/js/format.js` with them
    /// on the same cases, so the browser writes what the server does. Rewritten here when the
    /// data changes, failing the test until the new file is committed (as `corten::types` does).
    #[test]
    fn the_formats_scripts_get_are_the_ones_the_cases_check() {
        use crate::script::{__private::Ctx, ts, Arg};
        let locales: &[(&str, &__private::LocaleData)] = corten_macros::__all_locales!();
        let ctx = Ctx { current: None, home: None };
        let styles = [DateStyle::Short, DateStyle::Medium, DateStyle::Long, DateStyle::Full];
        let times = [TimeStyle::Short, TimeStyle::Medium];
        let mut specs = std::collections::BTreeMap::new();
        for line in include_str!("i18n/cases.tsv").lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
            let mut cols = line.split('\t');
            let (tag, kind, input) = (cols.next().unwrap(), cols.next().unwrap(), cols.next().unwrap());
            let data = locales.iter().find(|(t, _)| *t == tag).expect(tag).1;
            let mut out = String::new();
            let key = match kind.split(' ').collect::<Vec<_>>()[..] {
                ["number"] => {
                    Arg::<ts::NumberFormat>::write_arg(&NumberFormat::new(data), &ctx, &mut out);
                    "number".to_string()
                }
                ["percent", digits] => {
                    Arg::<ts::PercentFormat>::write_arg(&PercentFormat::new(data, digits.parse().unwrap()), &ctx, &mut out);
                    format!("percent {digits}")
                }
                ["change", digits] => {
                    Arg::<ts::PercentFormat>::write_arg(&PercentFormat::change(data, digits.parse().unwrap()), &ctx, &mut out);
                    format!("change {digits}")
                }
                ["money"] => {
                    let code = input.split_once(' ').unwrap().1;
                    Arg::<ts::MoneyFormat>::write_arg(&MoneyFormat::new(data, Currency::parse(code).unwrap()), &ctx, &mut out);
                    format!("money {code}")
                }
                ["signed_money"] => {
                    let code = input.split_once(' ').unwrap().1;
                    Arg::<ts::MoneyFormat>::write_arg(&MoneyFormat::signed(data, Currency::parse(code).unwrap()), &ctx, &mut out);
                    format!("signed_money {code}")
                }
                ["date", style, ..] => {
                    let style: usize = style.parse().unwrap();
                    let format = match style {
                        0..=3 => DateFormat::date(data, styles[style]),
                        4..=11 => DateFormat::date_time(data, styles[(style - 4) / 2], times[(style - 4) % 2]),
                        12..=13 => DateFormat::time(data, times[style - 12]),
                        14..=15 => DateFormat::date(data, MONTHS[style - 14]),
                        _ => DateFormat::date(data, DAYS[style - 16]),
                    };
                    // In UTC: scripts/format.mjs sets each case's offset (wire.json has one written).
                    Arg::<ts::DateFormat>::write_arg(&format, &ctx, &mut out);
                    format!("date {style}")
                }
                // Not a script's format: `corten_ui::RelativeTime` has the browser's Intl write it.
                ["relative", _] => continue,
                _ => panic!("{line}"),
            };
            let json = out[1..]
                .replace("&quot;", "\"")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&#39;", "'")
                .replace("&amp;", "&");
            specs.insert((tag, key), json);
        }
        // Each locale's plural table, as a plural message carries it, with every category's form
        // its own name, so format.mjs sees which one the browser picks.
        let names = [
            "[&quot;zero&quot;]",
            "[&quot;one&quot;]",
            "[&quot;two&quot;]",
            "[&quot;few&quot;]",
            "[&quot;many&quot;]",
            "[&quot;other&quot;]",
        ];
        for (tag, data) in locales {
            let mut out = String::new();
            format::plural_wire(data, &names, &mut out);
            let json = out[1..].replace("&quot;", "\"").replace("&amp;", "&");
            specs.insert((tag, "plural".to_string()), json);
        }
        let mut file =
            String::from("# Written by i18n.rs (the_formats_scripts_get_are_the_ones_the_cases_check). Do not edit.\n");
        file.push_str("# locale\tcase\tthe format a script gets\n");
        for ((tag, key), json) in &specs {
            file.push_str(&format!("{tag}\t{key}\t{json}\n"));
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/i18n/specs.tsv");
        if std::fs::read_to_string(path).ok().as_deref() != Some(file.as_str()) {
            std::fs::write(path, &file).unwrap();
            panic!("src/i18n/specs.tsv was out of date and is rewritten: commit it");
        }
    }

    mod regional {
        crate::i18n::messages! { pub struct Msg { "en-GB" => "src/i18n/en.json", "fr-LU" => "src/i18n/fr.json" } }
    }

    #[test]
    fn a_region_has_its_own_data_or_its_languages() {
        use regional::Msg;
        let at = parse_timestamp("2026-03-22T12:00:00Z").unwrap();
        assert_eq!(Msg::for_locale("en-GB").date(at, DateStyle::Short).to_string(), "22/03/2026", "en-GB's own");
        assert_eq!(Msg::for_locale("fr-LU").date(at, DateStyle::Long).to_string(), "22 mars 2026", "fr's");
    }

    #[test]
    fn decimals_round_half_away_from_zero_and_timestamps_parse_as_rfc_3339() {
        let d = |s| Decimal::parse(s).unwrap();
        assert_eq!(d("21.505").in_digits(2).to_string(), "21.51");
        assert_eq!(d("-21.505").in_digits(2).to_string(), "-21.51");
        assert_eq!(d("21.5049").in_digits(2).to_string(), "21.50");
        assert_eq!(d("9.995").in_digits(2).to_string(), "10.00");
        assert_eq!(d(".5").in_digits(0).to_string(), "1");
        assert_eq!(d("3").in_digits(3).to_string(), "3.000");
        assert_eq!(Minor(-5).in_digits(2).to_string(), "-0.05");
        assert_eq!(d("-0.25").to_string(), "-0.25");
        for bad in ["", "-", ".", "1e5", "1,5", " 1", "1.2.3", &"9".repeat(39)] {
            assert_eq!(Decimal::parse(bad), None, "{bad:?}");
        }
        assert_eq!("21.5".parse::<Decimal>(), Ok(Decimal::new(215, 1)));
        assert_eq!(Currency::parse("usd"), Some(Currency::new("USD")));
        assert_eq!(Currency::parse("US"), None);
        assert_eq!((Currency::new("JPY").digits(), Currency::new("KWD").digits(), Currency::new("XYZ").digits()), (0, 3, 2));
        // A currency has its digits when it is made, at compile time for a `const` one, whatever
        // case its code was written in.
        const KWD: Currency = Currency::new("KWD");
        assert_eq!((KWD.digits(), Currency::parse("kwd").map(|c| c.digits())), (3, Some(3)));
        assert_eq!(format!("{KWD:?}"), r#"Currency("KWD")"#);
        // Hashed by its code alone, as when a currency was only its code.
        let hash = |h: &dyn Fn(&mut std::collections::hash_map::DefaultHasher)| {
            use std::hash::Hasher as _;
            let mut state = std::collections::hash_map::DefaultHasher::new();
            h(&mut state);
            state.finish()
        };
        use std::hash::Hash as _;
        assert_eq!(hash(&|s| KWD.hash(s)), hash(&|s| (*b"KWD").hash(s)));

        let secs = |s| parse_timestamp(s).map(super::format::unix_seconds_for_test);
        assert_eq!(secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(secs("2026-03-22T12:00:00.000Z"), Some(1_774_180_800));
        assert_eq!(secs("2026-03-22t17:30:00+05:30"), Some(1_774_180_800));
        assert_eq!(secs("2026-03-22 07:00:00.123456-05"), Some(1_774_180_800));
        assert_eq!(secs("2026-03-22T07:00:00-0500"), Some(1_774_180_800));
        assert_eq!(secs("1969-12-31T23:59:59Z"), Some(-1));
        assert!(secs("2024-02-29T00:00:00Z").is_some());
        for bad in [
            "2026-02-29T00:00:00Z",
            "2026-13-01T00:00:00Z",
            "2026-03-22T24:00:00Z",
            "2026-03-22",
            "2026-03-22T12:00:00",
            "2026-03-22T12:00:00Zx",
            "2026-03-22T12:00:00+5",
        ] {
            assert_eq!(parse_timestamp(bad), None, "{bad}");
        }
    }

    #[test]
    fn numbers_money_and_dates_render_in_a_page_and_as_arguments() {
        let (en, fr) = (Msg::for_locale("en"), Msg::for_locale("fr"));
        let usd = Currency::new("USD");
        let at = parse_timestamp("2026-03-22T12:00:00Z").unwrap();
        let view = crate::html! {
            <p title={fr.money(Minor(-123450), usd)}>{en.item_listing_count(1234)}</p>
            <time>{en.date_time(at, DateStyle::Medium, TimeStyle::Short)}</time>
        };
        assert_eq!(
            view.to_html(),
            "<p title=\"-1\u{202f}234,50\u{a0}$US\">1,234 listings</p><time>Mar 22, 2026, 12:00 PM UTC</time>"
        );
        assert_eq!(fr.number(Decimal::parse("-1234.5").unwrap()).to_string(), "-1\u{202f}234,5");
        assert_eq!(
            en.date(std::time::UNIX_EPOCH - std::time::Duration::from_secs(1), DateStyle::Full).to_string(),
            "Wednesday, December 31, 1969"
        );
    }

    #[test]
    fn negotiation_prefers_quality_then_primary_language() {
        let locales = ["en", "fr", "pt-BR"];
        let pick = |header| locales[negotiate(&locales, header)];
        assert_eq!(pick(Some("fr-CA,fr;q=0.9,en;q=0.8")), "fr");
        assert_eq!(pick(Some("de, pt-br;q=0.5, en;q=0.4")), "pt-BR");
        assert_eq!(pick(Some("en;q=0.2, fr;q=0.9")), "fr");
        assert_eq!(pick(Some("de")), "en");
        assert_eq!(pick(Some("fr;q=0")), "en", "q=0 means not acceptable");
        assert_eq!(pick(Some("fr;q=x, pt")), "pt-BR", "a bad q skips that tag only");
        assert_eq!(pick(None), "en");
    }
}
