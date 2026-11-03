//! `#[derive(Id)]`: an element id as a type, so the markup that renders an element and the patch
//! that replaces or removes it cannot spell the id differently.
//!
//! `struct DeskStatusId;` is `desk-status`; `struct RowId<'a>(&'a str);` is `row-` and its key.
//! The name is the type's, without a trailing `Id`, in kebab case (after the library prefix,
//! `ui-`, in a crate that sets one). Each name is also an exported symbol ([`guards`]), so
//! two ids with the same name in one program fail to build. A library's symbol (a crate with a prefix) also carries its
//! version, so two semver-incompatible versions of one library still link together.

use proc_macro::{TokenStream, TokenTree};

use crate::{
    derive::{parse_item, string},
    tokens::{err, q, Error},
};

pub fn expand(input: TokenStream) -> Result<TokenStream, Error> {
    let item = parse_item(input, "Id", true)?;
    let usage = "Id is derived for a unit struct (`struct StatusId;`) or one holding its key (`struct RowId<'a>(&'a str);`)";
    if item.is_enum || item.body.as_ref().is_some_and(|b| !b.stream().is_empty()) {
        return err(item.name.span(), usage);
    }
    let keyed = match &item.tuple {
        None => false,
        Some(fields) if top_level_items(fields) == 1 => true,
        Some(fields) => return err(fields.span(), usage),
    };
    let rust = item.name.to_string();
    let base = rust.strip_suffix("Id").filter(|b| !b.is_empty()).unwrap_or(&rust);
    let mut name = crate::names::kebab(base);
    if let Some(prefix) = crate::script::prefix() {
        name = format!("{prefix}-{name}");
    }
    let write = if keyed {
        q("__OUT.push_str(__A0); ::corten::view::Render::render(&self.0, __OUT);", &[string(&format!("{name}-")).into()])
    } else {
        q("__OUT.push_str(__A0);", &[string(&name).into()])
    };
    // A debug build (every test) points at the guards, so a program that writes this id loads
    // them; a release build writes the id alone.
    let write = q("#[cfg(debug_assertions)] ::core::hint::black_box(__A0); __A1", &[anchor(&rust), write]);
    let mut out = item.impl_block(
        "::corten::view::Id",
        q(
            "const NAME: &'static str = __A0; fn write_id(&self, __OUT: &mut ::std::string::String) { __A1 }",
            &[string(&name).into(), write],
        ),
    );
    out.extend(item.impl_block(
        "::corten::view::Render",
        q("fn render(&self, out: &mut ::std::string::String) { ::corten::view::Id::write_id(self, out) }", &[]),
    ));
    out.extend(item.impl_block(
        "::corten::view::AttrValue",
        q(
            "fn write_attr(&self, name: &str, out: &mut ::std::string::String) {
                out.push_str(name);
                out.push_str(\"=\\\"\");
                ::corten::view::Id::write_id(self, out);
                out.push('\"');
            }",
            &[],
        ),
    ));
    out.extend(guards(&rust, &[("two_ids_are", &name, true)]));
    Ok(out)
}

/// Exported symbols for names the whole program shares (an id, a component's classes, a script's
/// module), so a second item with the same name fails to build, in this crate or in any other
/// linked into the program, rather than the app when it starts. The symbol says what clashed
/// (`corten__two_ids_are__settings_form`), since the error names only the symbol. With
/// `versioned`, a library's (a crate with a prefix, whose names in the page carry it) also carries
/// its version, so two semver-incompatible versions of one library still link together; a name
/// the page writes without the prefix (a class) is not versioned, since two versions would write
/// the same one.
///
/// They are in a module of their own, `__corten_guard_{item}`, beside `ANCHOR`, a static of the
/// item's own that its constant points at ([`anchor`]). A program that uses the item then loads
/// that module's object, the symbols with it, so two crates' namesakes fail to link: a linker takes
/// a library's object only for a symbol it needs, so without the anchor it would leave the
/// library's out, its symbols unseen, and the program would link (as a Windows GNU link did, #570).
///
/// Each name is a symbol twice. A static with it as its export name is what makes two namesakes in
/// one crate fail to compile, since rustc sees it. The same name with `.link` after it, defined in
/// assembly (`global_asm!`), is what makes two crates' namesakes fail to link: thin LTO resolves
/// two statics of one name to one before the linker sees them, so a pair linked in a release build
/// with thin LTO (#636), while assembly reaches the linker as it is, in every profile. Under LTO
/// every linked crate's assembly does, so a namesake in a crate the program links but never uses
/// fails there too. No Rust name has a dot in it, so the two never meet. `global_asm!` is stable on
/// the architectures listed in [`ASM`]; elsewhere only the statics are written, which a release
/// build with LTO does not check.
pub fn guards(item: &str, names: &[(&str, &str, bool)]) -> TokenStream {
    let mut items = String::new();
    let mut symbols = Vec::new();
    for (what, name, versioned) in names {
        let mut symbol = name.to_string();
        if *versioned && crate::script::prefix().is_some() {
            symbol = format!("{symbol}__{}", std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
        }
        let symbol: String = symbol.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
        let symbol = format!("corten__{what}__{symbol}");
        let n = symbols.len();
        items.push_str(&format!(
            "#[unsafe(export_name = __A{})] #[used] static NAME{n}: u8 = 0; #[cfg({ASM})] ::core::arch::global_asm!(__A{}, __A{}, \".byte 0\"); ",
            n + 1,
            n + 2,
            n + 3
        ));
        symbols.push(string(&symbol).into());
        symbols.push(string(&format!(".globl {symbol}.link")).into());
        symbols.push(string(&format!("{symbol}.link:")).into());
    }
    let mut args = vec![TokenTree::Ident(guard_module(item)).into()];
    args.extend(symbols);
    q(
        &format!(
            "#[doc(hidden)] #[allow(non_snake_case, dead_code)] pub(crate) mod __A0 {{ {items} pub static ANCHOR: u8 = 0; }}"
        ),
        &args,
    )
}

/// The architectures `global_asm!` is stable on (as of Rust 1.88, the workspace's minimum), as a
/// `cfg` predicate.
const ASM: &str = "any(target_arch = \"x86\", target_arch = \"x86_64\", target_arch = \"arm\", target_arch = \"aarch64\", target_arch = \"arm64ec\", target_arch = \"riscv32\", target_arch = \"riscv64\", target_arch = \"loongarch64\", target_arch = \"s390x\")";

/// `&__corten_guard_{item}::ANCHOR`, which the item's constant holds ([`guards`]).
pub fn anchor(item: &str) -> TokenStream {
    q("&__A0::ANCHOR", &[TokenTree::Ident(guard_module(item)).into()])
}

fn guard_module(item: &str) -> proc_macro::Ident {
    proc_macro::Ident::new(&format!("__corten_guard_{item}"), proc_macro::Span::call_site())
}

/// The number of comma-separated items at the top level of a group (`<..>` nests).
fn top_level_items(group: &proc_macro::Group) -> usize {
    let mut items = 0;
    let mut depth = 0i32;
    let mut pending = false;
    for token in group.stream() {
        match &token {
            TokenTree::Punct(p) if p.as_char() == '<' => depth += 1,
            TokenTree::Punct(p) if p.as_char() == '>' => depth -= 1,
            TokenTree::Punct(p) if p.as_char() == ',' && depth == 0 => {
                items += usize::from(pending);
                pending = false;
                continue;
            }
            _ => {}
        }
        pending = true;
    }
    items + usize::from(pending)
}
