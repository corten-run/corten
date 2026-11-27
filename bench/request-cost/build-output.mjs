// Read Cargo's JSON output from the feature-on build, in the probe's source directory.
// Print the compiler's diagnostics. Exit 10 only for a completed build whose only error is the
// probe's call to the missing App method; build.sh also checks Cargo's exit status before retrying.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const probe = resolve("src/main.rs");
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
      message.code?.code === "E0599" && /^no method named `own_http1` found for struct `App(?:<[^`]+>)?` in the current scope$/.test(message.message) &&
      message.spans.some((/** @type {any} */ span) => span.is_primary && resolve(span.file_name) === probe && span.text.some((/** @type {any} */ line) => line.text.slice(line.highlight_start - 1, line.highlight_end - 1) === "own_http1"));
  }
} catch (error) {
  console.error(`build.sh: invalid Cargo output: ${/** @type {Error} */ (error).message}`);
  process.exit(1);
}
process.exitCode = finished === true && errors === 0 ? 0 : finished === false && errors === 1 && onlyMissing ? 10 : 1;
