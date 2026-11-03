// @ts-check
// Imports relay.js, which imports shared.js and the views: two levels, for the swap preload test.
import { relay } from "./relay.js";
import { log } from "./shared.js";

export function chain() {
  relay();
  log("chain", 0, false);
}
