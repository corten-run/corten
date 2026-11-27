// The build record from build.sh and the refusal line from probe/src/main.rs.
import { existsSync, readFileSync } from "node:fs";

export const REFUSAL = "NO own_http1: this probe was built without the own-http1 feature, as against a Corten that has no App::own_http1";

/** @param {string} path */
export function builtWithoutOwnHttp1(path) {
  return existsSync(path) && readFileSync(path, "utf8") === "without\n";
}
