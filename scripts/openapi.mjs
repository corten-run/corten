// Checks every OpenAPI document an example keeps beside its code (examples/*/openapi.json, which
// corten::openapi::sync rewrites from the routes) against the OpenAPI 3.1 schema, so a document
// Corten generates is one other tools read. Run by npm run check.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Validator } from "@seriousme/openapi-schema-validator";

const examples = new URL("../examples/", import.meta.url);
let checked = 0;
let failed = 0;
for (const name of readdirSync(examples)) {
  const file = new URL(`${name}/openapi.json`, examples);
  if (!existsSync(file)) continue;
  const result = await new Validator().validate(JSON.parse(readFileSync(file, "utf8")));
  checked += 1;
  if (!result.valid) {
    failed += 1;
    console.error(`openapi: examples/${name}/openapi.json is not a valid OpenAPI document\n${JSON.stringify(result.errors, null, 2)}`);
  }
}
if (checked === 0) {
  console.error("openapi: no examples/*/openapi.json found; card-market keeps one");
  process.exit(1);
}
console.log(`openapi: ${checked - failed} of ${checked} documents are valid OpenAPI`);
process.exit(failed ? 1 : 0);
