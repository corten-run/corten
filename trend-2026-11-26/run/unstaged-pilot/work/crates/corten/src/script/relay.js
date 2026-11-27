// @ts-check
// A script that imports a module of its directory and the views, for the swap preload test.
import { log } from "./shared.js";
import * as views from "corten/views";

export function relay() {
  log("relay", Object.keys(views).length, false);
}
