// The requests the kit sends, the answer each must get, and how a connection's bytes are split
// into answers.
import zlib from "node:zlib";

/** The header lines a browser sends with a navigation (Firefox 140's). */
const BROWSER = [
  "User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language: en-US,en;q=0.5",
  "Accept-Encoding: gzip, deflate, br, zstd",
  "Sec-Fetch-Dest: document",
  "Sec-Fetch-Mode: navigate",
  "Sec-Fetch-Site: none",
];

const get = (path, more = []) => (port) => Buffer.from([`GET ${path} HTTP/1.1`, `Host: localhost:${port}`, ...more, "", ""].join("\r\n"), "latin1");
/** A GET with `Host` after the browser's lines: the last of eight. */
const last = (path) => (port) => Buffer.from([`GET ${path} HTTP/1.1`, ...BROWSER, `Host: localhost:${port}`, "", ""].join("\r\n"), "latin1");
/** A GET whose `Host` is `name` and the port. */
const hosted = (path, name) => (port) => Buffer.from([`GET ${path} HTTP/1.1`, `Host: ${name}:${port}`, "", ""].join("\r\n"), "latin1");
const post = (path, type, body, absolute = false) => (port) => {
  const origin = `http://localhost:${port}`;
  return Buffer.from([`POST ${absolute ? origin + path : path} HTTP/1.1`, `Host: localhost:${port}`, ...(absolute ? [`Origin: ${origin}`] : []), `Content-Type: ${type}`, `Content-Length: ${body.length}`, "", body].join("\r\n"), "latin1");
};

/**
 * A name of 40 bytes, as a site's host on a CDN is, one of 4,096 that ends in `_`, one of
 * 4,096 that ends in a percent-encoded byte, and one of 6, shorter than the eight bytes a name
 * must have to be read in line; and a name under `localhost`, which an app with Corten's
 * default names answers to, whose 11 bytes before `.localhost` are read in line.
 */
const NAME = "shop-2.example-cdn.region-9.example.test";
const LONG = `${"a".repeat(4095)}_`;
const ENCODED = `${"a".repeat(4093)}%4a`;
const SHORT = "a.test";
const SUBDOMAIN = "seller-desk.localhost";

/** The probe's page: from its doctype to its last row, 119 and 7 times 119. */
const PAGE = /^<!DOCTYPE html>.*<td>119<\/td><td>A row of the page, about as long as a row of a listing is<\/td><td>833<\/td><\/tr><\/table><\/main><\/body><\/html>$/s;

// Same URL, without Accept. Used only before recording the screen's answer, never counted.
export const screenDocument = get("/listing");
const LISTING = /^<!DOCTYPE html><html\b[^>]*><head>.*<title>Listing<\/title>.*<\/head><body><main>Ashen<\/main><\/body><\/html>$/s;

/**
 * Each case: the probe's configuration that answers it, its request for a port, and the answer
 * it must get: the body (as Latin-1 text, the whole of it or what it matches) and the
 * `Content-Encoding`, none unless given. A body sent with an encoding is the case's once decoded.
 * `hosts` is the `HOSTS` the probe is started with (`*`: it answers to any host); without it
 * the probe answers to its own, `localhost` and IP addresses.
 * @type {Record<string, { configuration: "api" | "pages" | "public-page" | "screen", hosts?: "*", request: (port: number) => Buffer, body: string | RegExp, encoding?: "zstd", type?: string }>}
 */
export const cases = {
  // A staged route in an API: typed query parameters in, a short String out.
  get: { configuration: "api", request: get("/baseline11?a=1&b=2"), body: "3" },
  post: { configuration: "api", request: post("/baseline11?a=1&b=2", "text/plain", "20"), body: "23" },
  "post-absolute": { configuration: "api", request: post("/baseline11?a=1&b=2", "text/plain", "20", true), body: "23" },
  // The same GET from a route that says `unstaged`, and the shortest unstaged answer.
  unstaged: { configuration: "api", request: get("/unstaged11?a=1&b=2"), body: "3" },
  pipeline: { configuration: "api", request: get("/pipeline"), body: "ok" },
  // In an app without an API: a short text answer and a page.
  text: { configuration: "pages", request: get("/text"), body: "ok" },
  page: { configuration: "pages", request: get("/page"), body: PAGE },
  "page-public": { configuration: "public-page", request: get("/page"), body: PAGE },
  // The same with a browser's header lines: the page is compressed, the short answers are not.
  "get-browser": { configuration: "api", request: get("/baseline11?a=1&b=2", BROWSER), body: "3" },
  "text-browser": { configuration: "pages", request: get("/text", BROWSER), body: "ok" },
  "page-browser": { configuration: "pages", request: get("/page", BROWSER), body: PAGE, encoding: "zstd" },
  // `get` and `unstaged` to an app that answers to any host, which reads a `Host` by itself and
  // not against names: with `Host` first, and last of a browser's eight lines.
  "get-any": { configuration: "api", hosts: "*", request: get("/baseline11?a=1&b=2"), body: "3" },
  "unstaged-any": { configuration: "api", hosts: "*", request: get("/unstaged11?a=1&b=2"), body: "3" },
  "get-any-last": { configuration: "api", hosts: "*", request: last("/baseline11?a=1&b=2"), body: "3" },
  "unstaged-any-last": { configuration: "api", hosts: "*", request: last("/unstaged11?a=1&b=2"), body: "3" },
  // `unstaged-any` with a longer name than `localhost`: one of 40 bytes of letters, digits, `-`
  // and `.`, and one of 4,095 `a` and a `_`, which a name holds but is none of those, last.
  "unstaged-any-name": { configuration: "api", hosts: "*", request: hosted("/unstaged11?a=1&b=2", NAME), body: "3" },
  "unstaged-any-long": { configuration: "api", hosts: "*", request: hosted("/unstaged11?a=1&b=2", LONG), body: "3" },
  // 4,093 `a` and `%4a`: the percent-encoded byte is read from the look that found the `%`, the
  // last 16 bytes, and a reader that read it from the name's start would read 4,080 bytes more.
  // This counts that read; a unit test in `security.rs`, not this case, catches the longer one.
  "unstaged-any-encoded": { configuration: "api", hosts: "*", request: hosted("/unstaged11?a=1&b=2", ENCODED), body: "3" },
  // `unstaged-any` with a name shorter than `localhost` and than the eight bytes read in line:
  // `a.test`, read by the table out of line.
  "unstaged-any-short": { configuration: "api", hosts: "*", request: hosted("/unstaged11?a=1&b=2", SHORT), body: "3" },
  // `unstaged` to an app that names its hosts, with a name under `localhost`: the part before
  // `.localhost`, `seller-desk`, is read as a name, where `localhost` itself is matched alone.
  "unstaged-subdomain": { configuration: "api", request: hosted("/unstaged11?a=1&b=2", SUBDOMAIN), body: "3" },
  "screen-json": { configuration: "screen", request: get("/listing", ["Accept: application/json"]), type: "application/json", body: '{"title":"Listing","data":{"name":"Ashen"}}' },
};

/** The cases a list names, or an error naming the one that is not a case. @param {string} list */
export function named(list) {
  const names = list.split(",");
  for (const name of names) if (!Object.hasOwn(cases, name)) throw new Error(`no case ${JSON.stringify(name)}; the cases are ${Object.keys(cases).join(", ")}`);
  return names;
}

/**
 * What is wrong with an answer to a case, or null when it is the answer the case must get: a
 * 200, the case's encoding and no other, and the case's body.
 * @param {string} name @param {Buffer} answer @returns {string | null}
 */
export function unexpected(name, answer) {
  return checkAnswer(name, /** @type {typeof cases[string]} */ (cases[name]), answer);
}

/** @param {Buffer} answer */
export function unexpectedScreenDocument(answer) {
  return checkAnswer("screen document", { type: "text/html; charset=utf-8", body: LISTING }, answer);
}

/** @param {string} name @param {{body: string | RegExp, encoding?: string, type?: string}} expected @param {Buffer} answer */
function checkAnswer(name, { body, encoding, type }, answer) {
  const end = answer.indexOf("\r\n\r\n");
  const head = answer.latin1Slice(0, end);
  if (!head.startsWith("HTTP/1.1 200 ")) return `not a 200: ${head.split("\r\n")[0]}`;
  if (type !== undefined) {
    const types = head.replace(/\r\n[ \t]+/g, " ").split("\r\n").filter((line) => /^content-type:/i.test(line));
    if (types.length !== 1 || types[0]?.slice("content-type:".length).replace(/^[ \t]+|[ \t]+$/g, "") !== type) return `expected a single Content-Type of ${type}`;
  }
  if (name === "page-public") {
    if (/^age:/im.test(head)) return "a kept public page (Age header)";
    const policy = head.split("\r\n").filter((line) => /^cache-control:/i.test(line));
    if (policy.length !== 1 || !/^cache-control:[ \t]*public, max-age=60[ \t]*$/i.test(policy[0] ?? "")) return "not the public page's Cache-Control";
  }
  const coded = /^content-encoding:[ \t]*(\S*)[ \t]*$/im.exec(head)?.[1];
  if (coded !== encoding) return `Content-Encoding ${coded ?? "none"}, not ${encoding ?? "none"}`;
  let bytes = answer.subarray(end + 4);
  if (encoding === "zstd") {
    // Node's zlib has zstd from 22.15; the repository's .node-version is later.
    if (typeof zlib.zstdDecompressSync !== "function") throw new Error(`${name}: this Node's zlib has no zstd to read the answer with (22.15 or later has)`);
    try {
      bytes = zlib.zstdDecompressSync(bytes);
    } catch (error) {
      return `not a zstd body: ${/** @type {Error} */ (error).message}`;
    }
  }
  const sent = bytes.latin1Slice();
  if (typeof body === "string" ? sent !== body : !body.test(sent)) return `not the body of ${name}: ${JSON.stringify(sent.slice(0, 80))}`;
  return null;
}

/** Splits the bytes a connection reads into answers, each a head and a body of its Content-Length. */
export class Answers {
  #unread = Buffer.alloc(0);

  /** The answers `chunk` completes, in order. @param {Buffer} chunk @returns {Buffer[]} */
  push(chunk) {
    this.#unread = this.#unread.length === 0 ? chunk : Buffer.concat([this.#unread, chunk]);
    const whole = [];
    for (;;) {
      const end = this.#unread.indexOf("\r\n\r\n");
      if (end < 0) return whole;
      const head = this.#unread.latin1Slice(0, end);
      const length = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(head);
      if (!length) throw new Error(`an answer without Content-Length:\n${head}`);
      const size = end + 4 + Number(length[1]);
      if (this.#unread.length < size) return whole;
      whole.push(this.#unread.subarray(0, size));
      this.#unread = this.#unread.subarray(size);
    }
  }
}

/**
 * An answer with what differs between two starts of one build replaced: the date, and a tag made
 * with a key of the process's own. @param {Buffer} answer
 */
export function masked(answer) {
  const end = answer.indexOf("\r\n\r\n");
  const head = answer.latin1Slice(0, end).replace(/^(date|etag): .*$/gim, "$1: -");
  return Buffer.concat([Buffer.from(head, "latin1"), answer.subarray(end)]);
}
