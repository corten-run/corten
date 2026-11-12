//! The second layer: where server and browser meet. The seams are typed, so one component of
//! this page is shown whole with its ties marked (`apart.rs`), then the page's own source broken
//! five ways with what the build said each time; and one form, answered by one handler as a
//! patch or as a page.
use corten::prelude::*;

use crate::{
    Here, StrikeForm,
    apart::Apart,
    code::{Code, Lang},
    looks::{Built, Slab},
    url,
    world::{Layer, Opening},
};

/// One way the page's source was broken, and what the build said.
pub struct Cut {
    /// What was done, as the reader picks it.
    pub label: &'static str,
    pub file: &'static str,
    /// The line as it was broken.
    pub broken: &'static str,
    /// The compiler's answer as it printed it, with `...` where part was left out.
    pub verdict: &'static str,
}

/// The handler behind the press, as `src/lib.rs` has it (a test there holds the two together).
pub const STRIKE: &str = r#"async fn strike(req: Req, State(works): State<Works>, Form(form): Form<StrikeForm>) -> HtmlResult {
    let name = app_name(&form.name);
    let plate = Plate::struck(&name, works.struck()).typed(&form.name);
    // With JavaScript: the plate alone, swapped in by its id.
    // Without: the form posts, and the reader lands back on the page at the plate.
    req.patch_or(Nameplate { plate: &plate, patched: true }, || async {
        req.redirect(&Here { plate: Some(&name), bare: form.bare, sorted: false }.wall(false).at(NameplateId))
    })
    .await
}
"#;

#[component(css)]
pub fn Seam<'a>(here: Here<'a>, plate: &'a Plate<'a>) -> impl Render {
    html! {
        <Opening layer={Layer::Seam} place="Layer 2 of 3" name="Seam" claim="What the two sides share is checked." />
        <Apart here={here} />
        <Breaks />
        <div class={Pressing}>
            <div class={Bench}>
                <div class={Slab {}}>
                    <h3>"One handler, with or without JavaScript"</h3>
                    <p>
                        "A form marked " <code>"data-patch"</code>
                        " gets back only the elements that changed. Without JavaScript the same form posts, and the same handler answers for the whole page."
                    </p>
                    <p>
                        "Name an app and strike its plate, and watch the count at the bottom of the window: the patch is one request of about a kilobyte, carrying only the nameplate's HTML. The first strike also loads two small files: the nameplate's script, and the event it fires, a DOM event whose class is generated from a Rust struct."
                    </p>
                    <Built on={&["HTML forms", "fetch", "303 See Other", "DOM events"][..]} />
                </div>
                <Press here={here} plate={plate} />
            </div>
            <Code file="src/lib.rs, the handler behind that button" lang={Lang::Rust} source={STRIKE} />
        </div>
    }
}

/// The exhibit under the component taken apart: pick a break, read the verdict. Radio buttons and `:has()` in `seam.css` show
/// the one picked, so it needs no script.
#[component(css = Seam)]
fn Breaks() -> impl Render {
    html! {
        <div class={Breaks}>
            <fieldset class={Cuts}>
                <legend class={Legend}>"Break one seam"</legend>
                <p class={Why}>
                    "A typo in one of those names fails the build, " <code>"corten check"</code>
                    " or startup, before any request, and so does a wrong route, form field or patch. So we broke this page's own source five ways, and kept what the compiler said."
                </p>
                for (n, cut) in crate::cuts::CUTS.iter().enumerate() {
                    <label class={CutLabel}>
                        <input
                            type="radio"
                            name="cut"
                            class={(
                                Pick,
                                match n {
                                    0 => Pick0,
                                    1 => Pick1,
                                    2 => Pick2,
                                    3 => Pick3,
                                    _ => Pick4,
                                },
                            )}
                            checked={n == 0}
                        >
                        <span>{cut.label}</span>
                    </label>
                }
            </fieldset>
            // All five lie in one place, so picking another moves nothing below it.
            <div class={Verdicts}>
                for (n, cut) in crate::cuts::CUTS.iter().enumerate() {
                    <div
                        class={(
                            Verdict,
                            match n {
                                0 => Verdict0,
                                1 => Verdict1,
                                2 => Verdict2,
                                3 => Verdict3,
                                _ => Verdict4,
                            },
                        )}
                    >
                        <Code file={cut.file} lang={Lang::Rust} source={cut.broken} />
                        <Code file="cargo build" lang={Lang::Rustc} source={cut.verdict} />
                    </div>
                }
            </div>
            <p class={Kept}>
                "Each answer is from a real build of this site with that one line changed. Where the build said more, its first error is shown and a line of dots marks what was left out."
            </p>
        </div>
    }
}

/// A plate to strike: the app's name as a crate can have it, and which plate this is.
pub struct Plate<'a> {
    pub name: Option<&'a str>,
    pub number: u64,
    /// Whether the name is not what the reader typed, which the plate then says.
    pub changed: bool,
}

impl<'a> Plate<'a> {
    /// The plate the page shows before anyone strikes one.
    pub fn blank() -> Self {
        Plate { name: None, number: 0, changed: false }
    }

    pub fn struck(name: &'a str, number: u64) -> Self {
        Plate { name: Some(name), number, changed: false }
    }

    /// The plate, knowing what the reader typed for it.
    pub fn typed(mut self, typed: &str) -> Self {
        self.changed = self.name != Some(typed.trim());
        self
    }
}

/// A plate was struck and its patch has landed on the page: the plate behind the page takes the
/// blow where it landed. Sent by the patch's own markup, so it is the server saying so.
#[corten::script::event]
pub struct PlateStruck {
    /// Which plate this server has struck, counted from 1.
    pub number: u32,
}

/// A name a crate can have, from what the reader typed: lowercase letters, digits and `-`,
/// starting with a letter, at most 32 long; `my-app` when nothing is left.
pub fn app_name(typed: &str) -> String {
    let mut name = String::new();
    for c in typed.trim().chars() {
        match c {
            'a'..='z' | '0'..='9' => name.push(c),
            'A'..='Z' => name.push(c.to_ascii_lowercase()),
            ' ' | '-' | '_' | '.' if !name.ends_with('-') => name.push('-'),
            _ => {}
        }
    }
    let name: String = name.trim_start_matches(|c: char| !c.is_ascii_lowercase()).chars().take(32).collect();
    let name = name.trim_end_matches('-');
    if name.is_empty() { "my-app".into() } else { name.into() }
}

/// The form and the plate it strikes.
#[component(css)]
pub(crate) fn Press<'a>(here: Here<'a>, plate: &'a Plate<'a>) -> impl Render {
    let f = StrikeForm::FIELDS;
    html! {
        <div class={Press}>
            <form method="post" action={url::Strike} data-patch class={Form}>
                if here.bare {
                    // The page whose scripts are blocked is the page the reader comes back to.
                    <input type="hidden" name={f.bare} value="true">
                }
                <label class={Field}>
                    <span class={Label}>"Name your app"</span>
                    <span class={Hint}>"Lowercase letters, digits and hyphens, as a crate is named."</span>
                    <input
                        name={f.name}
                        class={Input}
                        required
                        maxlength="32"
                        placeholder="acme-store"
                        autocomplete="off"
                        autocapitalize="none"
                        spellcheck="false"
                    >
                </label>
                <button class={Strike}>"Strike the plate"</button>
            </form>
            // The patch replaces the plate inside this, so what it says is announced.
            <div role="status"><Nameplate plate={plate} patched={false} /></div>
        </div>
    }
}

/// The plate's id: the page and the patch name the element the same way.
#[derive(Id)]
pub struct NameplateId;

/// The struck plate, drawn by the page and sent alone as the form's patch. `patched` is whether
/// this drawing is the patch, which the plate says of itself.
#[component(css, js)]
pub fn Nameplate<'a>(plate: &'a Plate<'a>, patched: bool) -> impl Patch {
    let struck = refs();
    html! {
        <div id={NameplateId} class={Nameplate}>
            match plate.name {
                Some(name) => <div class={Struck}>
                    <p ref={struck} class={Name}>{name}</p>
                    <p class={Marks}>
                        if plate.number > 0 {
                            "Plate " {plate.number} " from this server. "
                        }
                        "Built from " {crate::HEAT} "."
                        if plate.changed {
                            " Struck as " {name} ": a crate's name is lowercase letters, digits and hyphens."
                        }
                    </p>
                    <pre class={Run}><code>"corten new " {name} "\ncd " {name} "\ncorten dev"</code></pre>
                    <p class={How}>
                        if patched {
                            <span on:connect={js::landed(struck, u32::try_from(plate.number).unwrap_or(u32::MAX))}>
                                "Sent as a patch: this plate's HTML alone, swapped in by its id. Nothing else on the page was drawn again."
                            </span>
                        } else {
                            "Drawn with the page. With JavaScript on, the same handler sends this plate alone, as a patch."
                        }
                    </p>
                </div>,
                None => <p class={Blank}>"A blank plate. Name an app and strike it."</p>,
            }
        </div>
    }
}

#[cfg(test)]
mod tests {
    use super::app_name;

    #[test]
    fn a_name_is_one_a_crate_can_have() {
        assert_eq!(app_name("  Acme Store  "), "acme-store");
        assert_eq!(app_name("3d_viewer"), "d-viewer");
        assert_eq!(app_name("<script>alert(1)</script>"), "scriptalert1script");
        assert_eq!(app_name("--"), "my-app");
        assert_eq!(app_name("café"), "caf");
        assert_eq!(app_name(&"a".repeat(80)).len(), 32);
    }
}
