// The doctests' stand-in for the declarations `corten::types` writes (an app's types/app.d.ts):
// `Tab` is the Rust enum of that name in script.rs's doctests, `Options` and `SetListing` the structs in
// script/tests.rs (`SetListing` is also the doctests' screen data, `Level` their feed row).
export type Tab = "details" | "offers";
export interface Options {
  id: string;
  tags: string[];
}
export interface SetListing {
  name: string;
  products: string[];
}
export interface Level {
  id: string;
  qty: number;
}
