// The doctests' stand-in for the declarations `corten::types` writes (an app's types/app.d.ts):
// `Tab` is the Rust enum of that name in script.rs's doctests, `Options` the struct in script/tests.rs.
export type Tab = "details" | "offers";
export interface Options {
  id: string;
  tags: string[];
}
