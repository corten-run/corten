// The requests the kit sends, and how a connection's bytes are split into answers.

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
const post = (path, type, body) => (port) =>
  Buffer.from([`POST ${path} HTTP/1.1`, `Host: localhost:${port}`, `Content-Type: ${type}`, `Content-Length: ${body.length}`, "", body].join("\r\n"), "latin1");

/**
 * Each case: the probe's configuration that answers it, and its request for a port.
 * @type {Record<string, { configuration: "api" | "pages", request: (port: number) => Buffer }>}
 */
export const cases = {
  // A staged route in an API: typed query parameters in, a short String out.
  get: { configuration: "api", request: get("/baseline11?a=1&b=2") },
  post: { configuration: "api", request: post("/baseline11?a=1&b=2", "text/plain", "20") },
  // The same GET from a route that says `unstaged`, and the shortest unstaged answer.
  unstaged: { configuration: "api", request: get("/unstaged11?a=1&b=2") },
  pipeline: { configuration: "api", request: get("/pipeline") },
  // In an app without an API: a short text answer and a page.
  text: { configuration: "pages", request: get("/text") },
  page: { configuration: "pages", request: get("/page") },
  // The same with a browser's header lines: the page is compressed, the short answers are not.
  "get-browser": { configuration: "api", request: get("/baseline11?a=1&b=2", BROWSER) },
  "text-browser": { configuration: "pages", request: get("/text", BROWSER) },
  "page-browser": { configuration: "pages", request: get("/page", BROWSER) },
};

/** The cases counted 16 deep, where a client writes its requests without waiting for answers. */
export const deep = ["pipeline", "get", "unstaged", "text"];

/** The cases a list names, or an error naming the one that is not a case. @param {string} list */
export function named(list) {
  const names = list.split(",");
  for (const name of names) if (!Object.hasOwn(cases, name)) throw new Error(`no case ${JSON.stringify(name)}; the cases are ${Object.keys(cases).join(", ")}`);
  return names;
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

/** The middle of an odd number of counts, the upper of the two middle ones of an even number. @param {number[]} counts */
export function median(counts) {
  const ordered = [...counts].sort((a, b) => a - b);
  return /** @type {number} */ (ordered[Math.floor(ordered.length / 2)]);
}
