//! A deck builder: one screen where a player builds a deck from their collection, with most of
//! what rich client screens do (selection, drag and drop, keyboard moves, undo, a chart, autosave)
//! done in the browser, and the deck rules on the server alone.
//!
//! | Route | What |
//! |---|---|
//! | `GET /` | the collection and the deck; `?q=` filters and `?sort=` sorts the collection for a browser without JavaScript |
//! | `POST /deck` | the deck as its form holds it, with the version it was built on: saved once per submit key, refused by the rules (422) or when another tab saved first, or the server restarted (409) |
//! | `GET /feed/deck`, `/feed/deck/live` | the saved deck, which the page follows to notice another tab's save |
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use corten::{
    feed::{Feed, FeedResponse, Row, Since},
    http::StatusCode,
    prelude::*,
};
use serde::Serialize;

use crate::{
    cards::{self, Card, Refusal},
    text::Msg,
    views::{self, Answer},
};

/// A card in the saved deck and its copies: the rows of the deck's feed.
#[derive(Clone, Serialize, ToJson, Row)]
pub struct Slot {
    #[row(id)]
    pub id: String,
    pub count: u32,
}

/// The collection, and the deck saved from it. The deck's version is its feed's generation and
/// sequence number: each save that changes it is one write, so a page that knows both knows the
/// deck. The deck is kept in memory, so a restart starts a new generation at 0: a page left open
/// across it holds a version of another generation, which is stale whatever its number.
#[derive(Clone)]
pub struct Builder {
    cards: Arc<[Card]>,
    index: Arc<HashMap<String, usize>>,
    pub deck: Feed<Slot>,
    /// How long an applied save's key is remembered (`KEPT_FOR`).
    kept_for: Duration,
    /// The saves applied in the last day, so one sent again (its answer lost on the way) answers
    /// as it did. Every save holds this lock, so the version it checks is the one it writes after.
    /// A real store keeps the keys next to the deck, in its transaction.
    saves: Arc<Mutex<Saves>>,
}

/// The saves applied lately by submit key, and their keys oldest first, to forget them by age.
#[derive(Default)]
struct Saves {
    by_key: HashMap<SubmitKey, Applied>,
    order: VecDeque<(Instant, SubmitKey)>,
    /// The newest version a forgotten key made: a key unknown now may have made one up to it.
    forgotten_through: u64,
}

/// A save that was applied: which of the page's sends it was, and the version it made.
struct Applied {
    draft: u64,
    version: u64,
    // A plain form has no draft queue to reconcile a changed resend. Remember its
    // effective deck by collection index, not by a second copy of each card ID.
    ordinary: Option<Box<[(usize, u32)]>>,
}

/// How long an applied save's key is remembered: a page sends a lost save again within moments,
/// and a key forgotten sooner could not say the save was made. A day is what payment APIs keep
/// an idempotency key for. A page that sends one later is told its save may be in the deck
/// already (`Outcome::Stale`'s `unsure`), so its changes are not added again.
const KEPT_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// What became of a save, with the deck's version after it.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// Saved: the version it made, and which of the page's sends under this key it was.
    Saved { version: u64, draft: u64 },
    /// The rules refused it; the deck is as it was.
    Refused(u64, Refusal),
    /// A plain form reused a key that already saved a different deck.
    ChangedSubmit(u64),
    /// Autosave reused a key that saved before the builder owned the form.
    NativeSubmit,
    /// It was built on an older version: another tab saved first, or the server restarted since.
    /// `unsure`: a save made after that version has had its key forgotten, so if this key was
    /// sent before (its answer lost), that save may have been this one.
    Stale { version: u64, unsure: bool },
}

/// A deck as `card id -> copies`, no zeros.
pub type Deck = BTreeMap<String, u32>;

impl Builder {
    /// The collection (`DECK_CARDS` cards, 240 unless set) and the starter deck.
    pub fn new() -> Self {
        Self::with(std::env::var("DECK_CARDS").ok().and_then(|n| n.parse().ok()).unwrap_or(240))
    }

    /// `size` cards, and the starter deck at version 0 of a new generation.
    pub fn with(size: usize) -> Self {
        Self::from(size, None, KEPT_FOR)
    }

    /// `size` cards and the starter deck, in the generation named, or a new one, with keys kept
    /// for `kept_for`.
    fn from(size: usize, generation: Option<&str>, kept_for: Duration) -> Self {
        let cards: Arc<[Card]> = cards::collection(size).into();
        let index = cards.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        let starter = cards::STARTER.map(|(id, count)| Slot { id: id.into(), count });
        let deck = match generation {
            Some(generation) => Feed::follow(generation, 0, starter),
            None => Feed::new(starter),
        };
        Builder { cards, index: Arc::new(index), deck, kept_for, saves: Arc::default() }
    }

    pub fn card(&self, id: &str) -> Option<&Card> {
        self.index.get(id).map(|&i| &self.cards[i])
    }

    pub fn cards(&self) -> &[Card] {
        &self.cards
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Saves> {
        self.saves.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The deck's generation: a version is only comparable with one of the same generation.
    pub fn generation(&self) -> &str {
        self.deck.generation()
    }

    /// The saved deck and its version, read together.
    pub fn saved(&self) -> (u64, Deck) {
        let _saves = self.lock();
        (self.deck.seq(), self.deck.read(|rows| rows.values().map(|s| (s.id.clone(), s.count)).collect()))
    }

    /// Saves `deck` (the page's send `draft`) if the saved deck is still at `version` of
    /// `generation` and the rules allow it. On replay, the original draft identifies which
    /// scripted edit saved, but a native receipt does not name any scripted edit. A plain form
    /// only gets the original success if it sends the same deck.
    fn save(&self, generation: &str, version: u64, deck: Result<Deck, Refusal>, key: &SubmitKey, draft: u64) -> Outcome {
        let mut saves = self.lock();
        let at = Instant::now();
        while saves.order.front().is_some_and(|(applied, _)| at.duration_since(*applied) >= self.kept_for) {
            if let Some((_, old)) = saves.order.pop_front()
                && let Some(forgotten) = saves.by_key.remove(&old)
            {
                saves.forgotten_through = saves.forgotten_through.max(forgotten.version);
            }
        }
        let applied = saves.by_key.get(key);
        let deck = match deck {
            Ok(deck) => deck,
            // A malformed native resend still needs to say that the earlier save was made.
            Err(_) if draft == 0 && generation == self.generation() && applied.is_some() => {
                return Outcome::ChangedSubmit(self.deck.seq());
            }
            Err(refusal) => return Outcome::Refused(self.deck.seq(), refusal),
        };
        if let Some(applied) = applied {
            if draft != 0 && applied.draft == 0 {
                return Outcome::NativeSubmit;
            }
            if draft == 0
                && !applied.ordinary.as_ref().is_some_and(|original| {
                    deck.len() == original.len()
                        && deck
                            .iter()
                            .zip(original.iter())
                            .all(|((id, count), (index, before))| self.index.get(id) == Some(index) && count == before)
                })
            {
                return Outcome::ChangedSubmit(self.deck.seq());
            }
            return Outcome::Saved { version: applied.version, draft: applied.draft };
        }
        let now = self.deck.seq();
        if generation != self.generation() {
            // Every key and save of that generation went with the restart.
            return Outcome::Stale { version: now, unsure: false };
        }
        if version != now {
            return Outcome::Stale { version: now, unsure: saves.forgotten_through > version };
        }
        if let Err(refusal) = cards::check(&deck, |id| self.card(id)) {
            return Outcome::Refused(now, refusal);
        }
        // Read before the write: every save holds the lock, so nothing writes in between.
        let gone: Vec<String> = self.deck.read(|rows| rows.keys().filter(|id| !deck.contains_key(*id)).cloned().collect());
        self.deck.write(|tx| {
            for id in gone {
                tx.remove(&id);
            }
            for (id, &count) in &deck {
                if tx.get(id).map(|s| s.count) != Some(count) {
                    tx.insert(Slot { id: id.clone(), count });
                }
            }
        });
        let version = self.deck.seq();
        let ordinary = (draft == 0).then(|| deck.iter().map(|(id, &count)| (self.index[id], count)).collect());
        saves.by_key.insert(key.clone(), Applied { draft, version, ordinary });
        saves.order.push_back((at, key.clone()));
        Outcome::Saved { version, draft }
    }

    /// The deck a form posted: each card with its count, then the card an Add button names, or
    /// the picked cards for Add selected (a browser without JavaScript). A cleared count is none.
    fn posted(&self, input: &DeckInput) -> Result<Deck, Refusal> {
        if input.card.len() != input.count.len() {
            return Err(Refusal::NotANumber);
        }
        let mut deck = Deck::new();
        for (id, count) in input.card.iter().zip(&input.count) {
            let count = count.trim();
            let copies: u32 = if count.is_empty() { 0 } else { count.parse().map_err(|_| Refusal::NotANumber)? };
            let n = deck.entry(id.clone()).or_default();
            *n = n.saturating_add(copies);
        }
        let added = input.add.iter().chain(input.add_picked.as_ref().map_or(&[][..], |_| &input.pick[..]));
        for id in added {
            let n = deck.entry(id.clone()).or_default();
            *n = n.saturating_add(1);
        }
        deck.retain(|_, n| *n > 0);
        Ok(deck)
    }
}

/// The app: one screen, the save and the deck's feed.
pub fn app(builder: Builder) -> App {
    App::new(url::router(builder))
        .assets(views::Static)
        .components(views::COMPONENTS)
        .components(&[corten_ui::CopyButton])
        .messages::<Msg>()
        .error_page(views::error_page, ())
}

#[corten::routes(state = Builder)]
pub mod url {
    /// The builder. The query filters and sorts the collection for a browser without JavaScript.
    #[route("/", get = home)]
    #[derive(Default)]
    pub struct Home {
        #[route(query)]
        pub view: super::DeckQuery,
    }

    #[route("/deck", post = save)]
    pub struct Save;

    #[route("/feed/deck", get = deck_feed, rows = Slot)]
    pub struct DeckFeed;

    #[route("/feed/deck/live", get = deck_live, rows = Slot)]
    pub struct DeckLive;
}

/// How the collection is shown without JavaScript: a filter and an order. With it, the page
/// filters and sorts as the player types and clicks, with no request.
#[derive(Clone, Default, Route, Fields)]
#[route(query)]
pub struct DeckQuery {
    pub q: Option<String>,
    pub sort: Option<Sort>,
}

/// The collection's order.
#[derive(Clone, Copy, PartialEq, Debug, UrlValue)]
#[serde(rename_all = "kebab-case")]
pub enum Sort {
    Name,
    Cost,
    Owned,
}

/// The deck as its form posts it: each line's card and count (`card[i]` has `count[i]`), the
/// version it was built on, and, without JavaScript, the card an Add button names or the picked
/// cards with Add selected.
#[derive(Fields)]
pub struct DeckInput {
    /// The generation of the version the deck was built on.
    pub generation: String,
    pub version: u64,
    #[serde(default)]
    pub card: Vec<String>,
    /// As typed: a cleared count is no copies.
    #[serde(default)]
    pub count: Vec<String>,
    /// A collection row's Add button.
    pub add: Option<String>,
    /// The collection's checked rows, added by Add selected.
    #[serde(default)]
    pub pick: Vec<String>,
    /// The Add selected button.
    pub add_picked: Option<String>,
    /// This submit, so one sent again is saved once.
    pub submit: SubmitKey,
    /// Which of the page's sends this is: the script counts them, so an answer to one sent again
    /// says which deck was saved. 0 when the form is submitted without the builder's script.
    #[serde(default)]
    pub draft: u64,
    /// The page's filter and order, to come back to after a save without JavaScript.
    pub q: Option<String>,
    pub sort: Option<Sort>,
}

async fn deck_feed(State(builder): State<Builder>) -> FeedResponse<Slot> {
    builder.deck.snapshot()
}

async fn deck_live(State(builder): State<Builder>, since: Since) -> FeedResponse<Slot> {
    builder.deck.live(since)
}

async fn home(req: Req, State(builder): State<Builder>, Params(at): Params<url::Home>) -> HtmlResult {
    deck_page(&req, &builder, &at.view, &Answer::None, StatusCode::OK)
}

/// The builder's page, with what the last save said (a refused one without JavaScript).
fn deck_page(req: &Req, builder: &Builder, view: &DeckQuery, answer: &Answer, status: StatusCode) -> HtmlResult {
    let (version, saved) = builder.saved();
    let screen = views::screen(req.t(), builder, &saved, version, view, answer);
    req.page_with_status(status, html! { <views::Layout req={req} title="Deck builder">{screen}</views::Layout> })
}

/// Scripted saves get a note, unless the key already belongs to a native save. That refusal
/// draws the saved deck with a fresh key instead of asking the scripted queue to reconcile it.
/// An ordinary form submit redirects after a save or draws the refusal.
async fn save(req: Req, State(builder): State<Builder>, Form(input): Form<DeckInput>) -> HtmlResult {
    let outcome = builder.save(&input.generation, input.version, builder.posted(&input), &input.submit, input.draft);
    let (answer, status) = match &outcome {
        Outcome::Saved { version, draft } => (Answer::Saved { version: *version, draft: *draft }, StatusCode::OK),
        Outcome::Refused(version, refusal) => {
            (Answer::Refused { version: *version, message: refusal.to_string() }, StatusCode::UNPROCESSABLE_ENTITY)
        }
        Outcome::ChangedSubmit(version) => (
            Answer::Refused {
                version: *version,
                message: "This form already saved a different edit. Enter your change again on the saved deck below.".into(),
            },
            StatusCode::CONFLICT,
        ),
        Outcome::NativeSubmit => (Answer::NativeSubmit, StatusCode::CONFLICT),
        Outcome::Stale { version, unsure } => (Answer::Stale { version: *version, unsure: *unsure }, StatusCode::CONFLICT),
    };
    if input.draft != 0
        && let Some(action) = req.action()
        && let Some(note) = answer.patch()
    {
        return action.patch_with_status(status, note);
    }
    let view = DeckQuery { q: input.q, sort: input.sort };
    match outcome {
        Outcome::Saved { .. } => req.redirect(&url::Home { view }),
        _ => deck_page(&req, &builder, &view, &answer, status),
    }
}

#[cfg(test)]
mod tests {
    use corten::testing::{Answer, Call, Client, FormBody, submit_key};

    use super::*;

    /// The tests' deck generation.
    const GEN: &str = "g";

    /// Submit keys, for the store's own tests (the app's are sent with `submit_key()`).
    const KEYS: [&str; 5] = [
        "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "9b2c7f0e-1d2a-4c3b-8e4f-5a6b7c8d9e0f",
        "5d1c2b3a-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
        "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d",
        "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b",
    ];

    /// The deck form as the page holds it: `deck` built on `version`, under `key`. A scripted
    /// save supplies a nonzero draft and uses `Mode::Action`.
    fn saving<'c>(app: &'c Client, version: u64, deck: &[(&str, u32)], key: &SubmitKey) -> Call<'c, FormBody> {
        let f = DeckInput::FIELDS;
        let call = app.post(&url::Save).field(f.generation, GEN).field(f.version, version).field(f.submit, key);
        deck.iter().fold(call, |call, (id, n)| call.field(f.card, *id).field(f.count, n.to_string()))
    }

    /// The status and the body.
    fn read(res: &Answer) -> (StatusCode, &str) {
        (res.status(), res.text())
    }

    fn starter() -> Vec<(&'static str, u32)> {
        cards::STARTER.to_vec()
    }

    /// A failure is drawn in the layout, with the way back (`App::error_page`).
    #[tokio::test]
    async fn an_unknown_url_gets_the_error_page_in_the_layout() {
        let app = app(Builder::from(60, Some(GEN), KEPT_FOR)).test();
        let missing = app.get(&corten::Local::parse("/nope").unwrap()).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        let html = missing.text();
        assert!(html.contains("<h1>Not found</h1>") && html.contains("<strong>Deck builder</strong>"), "{html}");
        assert!(html.contains(r#"<a href="/">Back to the builder</a>"#), "{html}");
    }

    #[tokio::test]
    async fn a_save_writes_the_deck_once_per_key_and_answers_with_its_version() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let f = DeckInput::FIELDS;
        let mut deck = starter();
        deck.push(("salt-oracle", 1));
        let key = submit_key();
        let res = saving(&app, 0, &deck, &key).field(f.draft, 1).mode(Mode::Action).await;
        let (status, note) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert!(note.contains(r#"<span id="save-note""#) && note.contains("Saved."), "{note}");
        assert!(note.contains(r#"deck_builder.acknowledge($t,"Saved",1,1,false)"#), "{note}");
        assert_eq!(builder.saved().1.get("salt-oracle"), Some(&1));
        // Sent again (its answer lost): the same answer, no second write.
        let res = saving(&app, 0, &deck, &key).field(f.draft, 1).mode(Mode::Action).await;
        let (status, note) = read(&res);
        assert!(status == StatusCode::OK && note.contains(r#""Saved",1,1,false)"#), "{note}");
        assert_eq!(builder.deck.seq(), 1);
        // The same key with a changed deck (made while the answer was lost): nothing is written,
        // and the answer names the send that was saved, so the page sends the change next.
        deck.pop();
        let res = saving(&app, 0, &deck, &key).field(f.draft, 2).mode(Mode::Action).await;
        let (status, note) = read(&res);
        assert!(status == StatusCode::OK && note.contains(r#""Saved",1,1,false)"#), "{note}");
        assert_eq!((builder.deck.seq(), builder.saved().1.get("salt-oracle")), (1, Some(&1)));
        // A new key, built on the old version, is stale.
        let res = saving(&app, 0, &deck, &submit_key()).field(f.draft, 3).mode(Mode::Action).await;
        let (status, note) = read(&res);
        assert!(status == StatusCode::CONFLICT && note.contains(r#""Stale",1,0,false)"#), "{note}");
    }

    #[tokio::test]
    async fn runtime_sends_an_ordinary_form_when_the_builder_module_is_missing() {
        fn send(call: Call<'_, FormBody>) -> Call<'_, FormBody> {
            call.field(DeckInput::FIELDS.draft, 0)
                .mode(Mode::Action)
                .header(corten::http::header::HeaderName::from_static("prefer"), "corten-draws=whole")
        }

        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let f = DeckInput::FIELDS;
        let saved = send(saving(&app, 0, &starter(), &submit_key()).field(f.add, "pearl-diver").field(f.q, "pearl")).await;
        assert_eq!(saved.status(), StatusCode::NO_CONTENT);
        assert_eq!(saved.headers()["corten-location"], "/?q=pearl");

        let mut deck = starter();
        deck.push(("pearl-diver", 1));
        deck.iter_mut().find(|(id, _)| *id == "ashen-drake").unwrap().1 = 3;
        let refused = send(saving(&app, 1, &deck, &submit_key())).await;
        assert_eq!(refused.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(refused.text().contains("<!DOCTYPE html>") && refused.text().contains("You own 2 copies of Ashen Drake."));
        assert!(!refused.headers().contains_key("corten-patch"));

        let stale = send(saving(&app, 0, &starter(), &submit_key())).await;
        assert_eq!(stale.status(), StatusCode::CONFLICT);
        assert!(stale.text().contains("<!DOCTYPE html>") && stale.text().contains("changed in another tab"));
        assert!(stale.text().contains(r#"name="version" value="1""#));
        assert!(!stale.headers().contains_key("corten-patch"));
        assert_eq!((builder.deck.seq(), builder.saved().1.get("pearl-diver")), (1, Some(&1)));
    }

    #[tokio::test]
    async fn a_plain_resend_reports_a_different_edit_without_overwriting_the_saved_deck() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let key = submit_key();
        let f = DeckInput::FIELDS;
        let add = || saving(&app, 0, &starter(), &key).field(f.add, "pearl-diver");
        assert_eq!(add().await.status(), StatusCode::SEE_OTHER);

        let mut deck = starter();
        deck.push(("salt-oracle", 1));
        assert_eq!(saving(&app, 1, &deck, &submit_key()).await.status(), StatusCode::SEE_OTHER);
        // Even after the deck moves on, an exact resend is known to have been saved.
        assert_eq!(add().await.status(), StatusCode::SEE_OTHER);
        let changed = saving(&app, 0, &starter(), &key).await;
        assert_eq!(changed.status(), StatusCode::CONFLICT);
        assert!(changed.text().contains("Not saved: This form already saved a different edit."));
        assert!(changed.text().contains(r#"name="version" value="2""#));
        assert_eq!((builder.saved().0, builder.saved().1.get("salt-oracle")), (2, Some(&1)));
    }

    #[tokio::test]
    async fn a_malformed_retry_reconciles_the_saved_deck_but_a_fresh_key_gets_a_refusal() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let f = DeckInput::FIELDS;
        let key = submit_key();
        let mut deck = starter();
        let lost = saving(&app, 0, &deck, &key).field(f.add, "salt-oracle").await;
        assert_eq!(lost.status(), StatusCode::SEE_OTHER);

        let invalid = |version, key: &SubmitKey| {
            saving(&app, version, &deck[1..], key)
                .field(f.card, "gravel-sprite")
                .field(f.count, "0.5")
                .field(f.add, "salt-oracle")
        };
        let retry = invalid(0, &key).await;
        let (status, page) = read(&retry);
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(page.contains("This form already saved a different edit."));
        assert!(page.contains(r#"name="version" value="1""#));
        assert!(page.contains(r#"name="card" value="salt-oracle""#));

        let refused = invalid(1, &submit_key()).await;
        let (status, page) = read(&refused);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(page.contains("Enter a number of copies"));
        assert_eq!((builder.saved().0, builder.saved().1.get("salt-oracle")), (1, Some(&1)));

        deck[0].1 = 2;
        deck.push(("salt-oracle", 1));
        let corrected = saving(&app, 1, &deck, &submit_key()).await;
        assert_eq!(corrected.status(), StatusCode::SEE_OTHER);
        let (version, saved) = builder.saved();
        assert_eq!((version, saved.get("gravel-sprite"), saved.get("salt-oracle")), (2, Some(&2), Some(&1)));
    }

    #[tokio::test]
    async fn autosave_cannot_acknowledge_a_native_save_as_its_own_draft() {
        let f = DeckInput::FIELDS;
        for submitter in ["Save", "Add", "Add selected"] {
            let builder = Builder::from(60, Some(GEN), KEPT_FOR);
            let app = app(builder.clone()).test();
            let key = submit_key();
            let mut saved = starter();
            saved.push(("pearl-diver", 1));
            let native = match submitter {
                "Save" => saving(&app, 0, &saved, &key),
                "Add" => saving(&app, 0, &starter(), &key).field(f.add, "pearl-diver"),
                _ => saving(&app, 0, &starter(), &key).field(f.add_picked, "1").field(f.pick, "pearl-diver"),
            };
            assert_eq!(native.await.status(), StatusCode::SEE_OTHER, "{submitter}");

            let mut added_again = starter();
            added_again.push(("pearl-diver", 2));
            // A draft built before the feed arrived and one built after it both hold the old key.
            for (version, deck) in [(0, &saved), (1, &added_again)] {
                let res = saving(&app, version, deck, &key)
                    .field(f.draft, 1)
                    .mode(Mode::Action)
                    .header(corten::http::header::HeaderName::from_static("prefer"), "corten-draws=whole")
                    .await;
                assert_eq!(res.status(), StatusCode::CONFLICT, "{submitter}, version {version}");
                assert!(res.headers().contains_key("corten-shell"), "{submitter}");
                assert!(!res.headers().contains_key("corten-patch") && !res.headers().contains_key("corten-page"), "{submitter}");
                assert!(res.text().contains("<!DOCTYPE html>"), "{submitter}");
                assert!(res.text().contains("This form already saved before autosave started."), "{submitter}");
                assert!(!res.text().contains("deck_builder.acknowledge("), "{submitter}");
                assert!(res.text().contains(r#"name="version" value="1""#), "{submitter}");
                assert_eq!((builder.saved().0, builder.saved().1.get("pearl-diver")), (1, Some(&1)), "{submitter}");
            }
        }
    }

    #[test]
    fn a_version_from_before_a_restart_is_stale_after_it() {
        let key = |i: usize| {
            use serde::{
                Deserialize,
                de::{IntoDeserializer, value::Error},
            };
            SubmitKey::deserialize(IntoDeserializer::<Error>::into_deserializer(KEYS[i])).unwrap()
        };
        let deck = |extra: &str| {
            let mut deck: Deck = cards::STARTER.iter().map(|&(id, n)| (id.to_string(), n)).collect();
            deck.insert(extra.into(), 1);
            Ok(deck)
        };
        // A page saved twice before the restart: version 2.
        let before = Builder::from(60, Some("a"), KEPT_FOR);
        before.save("a", 0, deck("salt-oracle"), &key(0), 1);
        assert_eq!(before.save("a", 1, deck("pearl-diver"), &key(1), 2), Outcome::Saved { version: 2, draft: 2 });
        // After it the deck starts again in another generation, and writes as far as version 2:
        // the same number is not the same deck.
        let after = Builder::from(60, Some("b"), KEPT_FOR);
        after.save("b", 0, deck("lantern-warden"), &key(2), 1);
        after.save("b", 1, deck("undertow-serpent"), &key(3), 2);
        assert_eq!(after.save("a", 2, deck("kiln-colossus"), &key(4), 3), Outcome::Stale { version: 2, unsure: false });
        assert_eq!(after.save("b", 2, deck("kiln-colossus"), &key(4), 3), Outcome::Saved { version: 3, draft: 3 });
    }

    #[test]
    fn a_save_sent_again_after_its_key_is_forgotten_is_stale_and_unsure() {
        let key = |i: usize| {
            use serde::{
                Deserialize,
                de::{IntoDeserializer, value::Error},
            };
            SubmitKey::deserialize(IntoDeserializer::<Error>::into_deserializer(KEYS[i])).unwrap()
        };
        let mut deck: Deck = cards::STARTER.iter().map(|&(id, n)| (id.to_string(), n)).collect();
        deck.insert("pearl-diver".into(), 1);
        // Keys forgotten at once: the first save's answer was lost, and it is sent again later.
        let builder = Builder::from(60, Some(GEN), Duration::ZERO);
        assert_eq!(builder.save(GEN, 0, Ok(deck.clone()), &key(0), 0), Outcome::Saved { version: 1, draft: 0 });
        assert_eq!(builder.save(GEN, 0, Err(Refusal::NotANumber), &key(0), 0), Outcome::Refused(1, Refusal::NotANumber));
        assert_eq!(builder.save(GEN, 0, Ok(deck.clone()), &key(0), 0), Outcome::Stale { version: 1, unsure: true });
        // Built on the version after that save, nothing forgotten could be it.
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        builder.save(GEN, 0, Ok(deck.clone()), &key(0), 1);
        deck.insert("pearl-diver".into(), 2);
        builder.save(GEN, 1, Ok(deck.clone()), &key(1), 2);
        assert_eq!(builder.save(GEN, 1, Ok(deck), &key(2), 3), Outcome::Stale { version: 2, unsure: false });
    }

    #[tokio::test]
    async fn a_deck_the_rules_refuse_is_not_saved_and_says_why() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let mut deck = starter();
        deck[4] = ("ashen-drake", 3);
        let f = DeckInput::FIELDS;
        let res = saving(&app, 0, &deck, &submit_key()).field(f.draft, 1).mode(Mode::Action).await;
        let (status, note) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(note.contains("Not saved: You own 2 copies of Ashen Drake."), "{note}");
        assert!(note.contains(r#""Refused",0,0,false)"#), "{note}");
        assert_eq!(builder.deck.seq(), 0);
        let res = saving(&app, 0, &[], &submit_key())
            .field(f.card, "gravel-sprite")
            .field(f.count, "two")
            .field(f.draft, 1)
            .mode(Mode::Action)
            .await;
        let (status, note) = read(&res);
        assert!(status == StatusCode::UNPROCESSABLE_ENTITY && note.contains("Enter a number of copies"), "{note}");
    }

    #[tokio::test]
    async fn without_javascript_add_and_save_are_forms_and_a_refusal_is_the_page() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let f = DeckInput::FIELDS;
        // An Add button: the deck as it is, and one more card.
        let res = saving(&app, 0, &starter(), &submit_key())
            .field(f.add, "pearl-diver")
            .field(f.q, "pearl")
            .field(f.sort, Sort::Cost)
            .await;
        assert_eq!(
            (res.status(), res.headers().get("location").map(|l| l.to_str().unwrap())),
            (StatusCode::SEE_OTHER, Some("/?q=pearl&sort=cost"))
        );
        assert_eq!(builder.saved().1.get("pearl-diver"), Some(&1));
        // Add selected: every picked card.
        let mut deck = starter();
        deck.push(("pearl-diver", 1));
        let picked = saving(&app, 1, &deck, &submit_key())
            .field(f.pick, "undertow-serpent")
            .field(f.pick, "moth-court-herald")
            .field(f.add_picked, "1");
        assert_eq!(picked.await.status(), StatusCode::SEE_OTHER);
        let saved = builder.saved().1;
        assert_eq!((saved.get("undertow-serpent"), saved.get("moth-court-herald")), (Some(&1), Some(&3)));
        // A count cleared is none: the card leaves the deck.
        let mut deck: Vec<_> = saved.iter().map(|(id, n)| (id.as_str(), *n)).collect();
        deck.retain(|(id, _)| *id != "pearl-diver");
        let cleared = saving(&app, 2, &deck, &submit_key()).field(f.card, "pearl-diver").field(f.count, "");
        assert_eq!(cleared.await.status(), StatusCode::SEE_OTHER);
        assert_eq!(builder.saved().1.get("pearl-diver"), None);
        // Refused: the page, with the reason and the deck as saved.
        let res = saving(&app, 3, &deck, &submit_key())
            .field(f.card, "kiln-colossus")
            .field(f.count, "1")
            .field(f.add, "kiln-colossus")
            .await;
        let (status, page) = read(&res);
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(page.contains("<!DOCTYPE html>") && page.contains("You own 1 copy of Kiln Colossus."), "{page}");
    }

    #[tokio::test]
    async fn a_save_built_on_an_old_version_is_refused_as_stale_and_the_page_shows_the_deck_now() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder.clone()).test();
        let mut deck = starter();
        deck.push(("pearl-diver", 2));
        assert_eq!(saving(&app, 0, &deck, &submit_key()).await.status(), StatusCode::SEE_OTHER);
        // Another tab, still at version 0.
        let res = saving(&app, 0, &starter(), &submit_key()).await;
        let (status, page) = read(&res);
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(page.contains("changed in another tab") && page.contains(r#"name="version" value="1""#), "{page}");
        assert!(page.contains("Pearl Diver"), "the deck as it is now: {page}");
    }

    #[tokio::test]
    async fn the_page_lists_the_collection_and_the_deck_and_filters_without_javascript() {
        let builder = Builder::from(60, Some(GEN), KEPT_FOR);
        let app = app(builder).test();
        let res = app.get(&url::Home::default()).await;
        let (status, page) = read(&res);
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page.matches(r#"<tr data-key=""#).count(), 60, "every card is a CollectionRow");
        assert_eq!(
            page.matches(r#"<li data-key=""#).count(),
            cards::STARTER.len() + 1,
            "every deck line is a DeckLine, and the template's"
        );
        assert!(page.contains("/scripts/deck_builder.js\">") && !page.contains("/scripts/save_note.js\">"), "{page}");
        assert!(!page.contains("deck_builder.acknowledge("), "a whole page does not acknowledge an autosave");
        let view = DeckQuery { q: Some("drake".into()), sort: Some(Sort::Cost) };
        let res = app.get(&url::Home { view }).await;
        let page = res.text();
        assert_eq!(page.matches(r#"<tr data-key=""#).count(), 60, "the filter hides rows; the script can show them again");
        let shown: Vec<&str> =
            page.split(r#"<tr data-key=""#).skip(1).filter(|row| !row[..row.find('>').unwrap()].contains(" hidden")).collect();
        assert_eq!(shown.len(), 1, "one card matches: {shown:?}");
        assert!(shown[0].starts_with("ashen-drake"), "{}", shown[0]);
        // Sorted by cost, cheapest first.
        let first = page.split(r#"<tr data-key=""#).nth(1).unwrap();
        assert!(first.contains("<td><span>0</span></td>") || first.contains("<td><span>1</span></td>"), "{first}");
    }

    /// The scripts' data is checked against these declarations by `npm run check`.
    #[test]
    fn script_types_match_the_server() {
        corten::types::Types::new()
            .add::<Slot>()
            .components(views::COMPONENTS)
            .sync(concat!(env!("CARGO_MANIFEST_DIR"), "/types/app.d.ts"));
    }
}
