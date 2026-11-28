// Read Cargo's JSON output from the feature-on build, in the probe's source directory.
// Print the compiler's diagnostics. Exit 10 only for a completed build whose only error is the
// probe's call to the missing App method; build.sh also checks Cargo's exit status before retrying.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const probe = resolve("src/main.rs");
const call = "    Ok(app.own_http1(true))";

/** The primary span must mark the method in `switched`, not a call elsewhere in the probe. @param {any} span */
function switchedCall(span) {
  if (!span.is_primary || resolve(span.file_name) !== probe || span.line_start !== span.line_end || span.text.length !== 1) return false;
  const [word] = span.text;
  if (word.text !== call || word.text.slice(word.highlight_start - 1, word.highlight_end - 1) !== "own_http1") return false;
  // Follow the call if it moves; if the guard, signature or call changes, update this match too.
  const source = readFileSync(probe, "utf8").split(/\r?\n/);
  const sites = source.flatMap((line, at) => line === call && source[at - 1] === "fn switched(app: App) -> Result<App, Box<dyn std::error::Error>> {" && source[at - 2] === '#[cfg(feature = "own-http1")]' ? [at + 1] : []);
  return sites.length === 1 && span.line_start === sites[0];
}

let errors = 0;
let onlyMissing = true;
let finished;
try {
  for (const line of readFileSync(process.argv[2], "utf8").trimEnd().split("\n")) {
    const event = JSON.parse(line);
    if (finished !== undefined) throw new Error("output after build-finished");
    if (event.reason === "build-finished") {
      if (typeof event.success !== "boolean") throw new Error("invalid build-finished");
      finished = event.success;
    }
    if (event.reason !== "compiler-message") continue;
    const { message, target } = event;
    if (message.rendered) process.stderr.write(message.rendered);
    if (message.level !== "error") continue;
    errors += 1;
    onlyMissing &&=
      target.name === "probe" && resolve(target.src_path) === probe &&
      message.code?.code === "E0599" && /^no method named `own_http1` found for struct `(?:corten::)?App(?:<[^`]+>)?` in the current scope$/.test(message.message) &&
      message.spans.some(switchedCall);
  }
} catch (error) {
  console.error(`build.sh: invalid Cargo output: ${/** @type {Error} */ (error).message}`);
  process.exit(1);
}
process.exitCode = finished === true && errors === 0 ? 0 : finished === false && errors === 1 && onlyMissing ? 10 : 1;
