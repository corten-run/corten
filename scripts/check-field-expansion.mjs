// Compare html! output with a checkout from before the field-kind check.
// Run from the repo root: node scripts/check-field-expansion.mjs <baseline checkout>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const before = process.argv[2];
assert(before, "pass the baseline checkout");
const scratch = mkdtempSync(join(tmpdir(), "corten-field-expansion-"));

function expand(root, label, source) {
  const rustc = (args, env) => execFileSync("rustc", args, { encoding: "utf8", env });
  const output = join(scratch, label);
  mkdirSync(output);
  rustc([
    "--crate-name", "corten_macros", "--crate-type", "proc-macro", "--edition", "2021", "--extern", "proc_macro",
    resolve(root, "crates/corten-macros/src/lib.rs"), "--out-dir", output,
  ], process.env);
  const library = readdirSync(output).find((file) => /\.(dll|so|dylib)$/.test(file));
  assert(library, "rustc did not produce the macro library");
  const fixture = join(scratch, "probe.rs");
  writeFileSync(fixture, source);
  // Only the syntax probe uses the compiler's expansion printer, not the macro's build.
  return rustc([
    "--crate-name", "field_expansion_probe", "--crate-type", "lib", "--edition", "2021",
    "--extern", `corten_macros=${join(output, library)}`, "-Zunpretty=expanded", fixture,
  ], { ...process.env, RUSTC_BOOTSTRAP: "field_expansion_probe" });
}

try {
  const source = `use corten_macros::html;
    extern crate self as corten;
    mod view {
        pub struct Html;
        pub mod __private {
            pub trait AttrViaDisplay {}
            pub trait AttrViaValue {}
            pub trait ViaDisplay {}
            pub trait ViaRender {}
            pub trait ProofPatch {}
            pub trait ProofOther {}
            pub trait ProofId {}
            pub trait ProofNotId {}
            pub struct Attr;
            pub struct TextOrElementWithoutId;
        }
    }
    mod script {
        pub trait Bind {}
        pub mod __private { pub fn data_on() {} }
    }
    struct Ship;
    struct Names { weight: &'static str }
    impl Ship { const FIELDS: Names = Names { weight: "weight" }; }
    mod js {
        pub fn caption(_: &str) {}
        pub fn input(_: &str) {}
    }
    fn matched() {
        let name = "caption";
        let _ = html! {
            let f = Ship::FIELDS;
            <form><input name={name}><button on:click={js::caption(name)}>"Caption"</button></form>
        };
    }
    fn unmatched() {
        let _ = html! {
            let f = Ship::FIELDS;
            <form><input name="posted"><button on:click={js::input(f.weight)}>"Fill"</button></form>
        };
    }
  `;
  assert.equal(expand(".", "after", source), expand(before, "before", source));
  console.log("Matched non-field and unmatched expansions are identical to the baseline.");
} finally {
  rmSync(scratch, { recursive: true });
}
