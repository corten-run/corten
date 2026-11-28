// node --test bench/request-cost/requests.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { Answers, cases, masked, named, screenDocument, unexpected, unexpectedScreenDocument } from "./requests.mjs";

const answer = (/** @type {string} */ body, more = "", status = "200 OK") => Buffer.from(`HTTP/1.1 ${status}\r\ncontent-length: ${Buffer.byteLength(body, "latin1")}\r\n${more}\r\n${body}`, "latin1");

test("a connection's bytes are split into answers wherever a read ends", () => {
  const two = Buffer.concat([answer("3"), answer("ok")]);
  for (let cut = 1; cut < two.length; cut += 1) {
    const answers = new Answers();
    const whole = [...answers.push(two.subarray(0, cut)), ...answers.push(two.subarray(cut))];
    assert.deepEqual(whole.map(String), [String(answer("3")), String(answer("ok"))], `cut at ${cut}`);
  }
});

test("a read that ends inside an answer gives nothing until the rest comes", () => {
  const answers = new Answers();
  const bytes = answer("spec ok");
  assert.deepEqual(answers.push(bytes.subarray(0, bytes.length - 1)), []);
  assert.equal(answers.push(bytes.subarray(bytes.length - 1)).length, 1);
});

test("an answer's length is its Content-Length whatever the header's case, and a body may hold a blank line", () => {
  const answers = new Answers();
  const bytes = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length:  6 \r\n\r\na\r\n\r\nb", "latin1");
  assert.deepEqual(answers.push(Buffer.concat([bytes, bytes])).map(String), [String(bytes), String(bytes)]);
});

test("an answer without Content-Length is refused, not waited for", () => {
  assert.throws(() => new Answers().push(Buffer.from("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n")), /without Content-Length/);
});

test("masking replaces the date and the tag and nothing else", () => {
  const sent = answer("ok", "date: Wed, 25 Nov 2026 00:00:00 GMT\r\nETag: \"abc\"\r\nvary: accept-encoding\r\n");
  assert.equal(String(masked(sent)), "HTTP/1.1 200 OK\r\ncontent-length: 2\r\ndate: -\r\nETag: -\r\nvary: accept-encoding\r\n\r\nok");
  // A body that looks like a header line is left as it is.
  const body = answer("date: today\r\n");
  assert.equal(String(masked(body)), String(body));
});

test("each case is its request, byte for byte, to its configuration", () => {
  const host = "Host: localhost:8123\r\n";
  const browser =
    "User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0\r\n" +
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n" +
    "Accept-Language: en-US,en;q=0.5\r\n" +
    "Accept-Encoding: gzip, deflate, br, zstd\r\n" +
    "Sec-Fetch-Dest: document\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Site: none\r\n";
  const expected = {
    get: ["api", `GET /baseline11?a=1&b=2 HTTP/1.1\r\n${host}\r\n`],
    post: ["api", `POST /baseline11?a=1&b=2 HTTP/1.1\r\n${host}Content-Type: text/plain\r\nContent-Length: 2\r\n\r\n20`],
    "post-absolute": ["api", `POST http://localhost:8123/baseline11?a=1&b=2 HTTP/1.1\r\n${host}Origin: http://localhost:8123\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n20`],
    unstaged: ["api", `GET /unstaged11?a=1&b=2 HTTP/1.1\r\n${host}\r\n`],
    pipeline: ["api", `GET /pipeline HTTP/1.1\r\n${host}\r\n`],
    text: ["pages", `GET /text HTTP/1.1\r\n${host}\r\n`],
    page: ["pages", `GET /page HTTP/1.1\r\n${host}\r\n`],
    "page-public": ["public-page", `GET /page HTTP/1.1\r\n${host}\r\n`],
    "screen-json": ["screen", `GET /listing HTTP/1.1\r\n${host}Accept: application/json\r\n\r\n`],
    "get-browser": ["api", `GET /baseline11?a=1&b=2 HTTP/1.1\r\n${host}${browser}\r\n`],
    "text-browser": ["pages", `GET /text HTTP/1.1\r\n${host}${browser}\r\n`],
    "page-browser": ["pages", `GET /page HTTP/1.1\r\n${host}${browser}\r\n`],
    "get-any": ["api", `GET /baseline11?a=1&b=2 HTTP/1.1\r\n${host}\r\n`, "*"],
    "unstaged-any": ["api", `GET /unstaged11?a=1&b=2 HTTP/1.1\r\n${host}\r\n`, "*"],
    "get-any-last": ["api", `GET /baseline11?a=1&b=2 HTTP/1.1\r\n${browser}${host}\r\n`, "*"],
    "unstaged-any-last": ["api", `GET /unstaged11?a=1&b=2 HTTP/1.1\r\n${browser}${host}\r\n`, "*"],
    "unstaged-any-name": ["api", "GET /unstaged11?a=1&b=2 HTTP/1.1\r\nHost: shop-2.example-cdn.region-9.example.test:8123\r\n\r\n", "*"],
    "unstaged-any-long": ["api", `GET /unstaged11?a=1&b=2 HTTP/1.1\r\nHost: ${"a".repeat(4095)}_:8123\r\n\r\n`, "*"],
    "unstaged-any-encoded": ["api", `GET /unstaged11?a=1&b=2 HTTP/1.1\r\nHost: ${"a".repeat(4093)}%4a:8123\r\n\r\n`, "*"],
    "unstaged-any-short": ["api", "GET /unstaged11?a=1&b=2 HTTP/1.1\r\nHost: a.test:8123\r\n\r\n", "*"],
    "unstaged-subdomain": ["api", "GET /unstaged11?a=1&b=2 HTTP/1.1\r\nHost: seller-desk.localhost:8123\r\n\r\n"],
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(cases).map(([name, { configuration, hosts, request }]) => [name, [configuration, request(8123).latin1Slice(), ...(hosts === undefined ? [] : [hosts])]]),
    ),
    expected,
  );
  // The names other than `localhost`: 40 bytes, 4,096 whose last is the only one not a letter,
  // 4,096 whose last three are its only percent-encoded byte, 6, fewer than the 8 read in line,
  // and one under `localhost` whose part before it is 11 bytes, between the 8 and 16 read in line.
  const name = (/** @type {string} */ name) => /^Host: (.*):8123$/m.exec(cases[name]?.request(8123).latin1Slice() ?? "")?.[1] ?? "";
  assert.equal(name("unstaged-any-name").length, 40);
  assert.equal(name("unstaged-any-long").length, 4096);
  assert.equal(name("unstaged-any-long").replace(/^a+/, ""), "_");
  assert.equal(name("unstaged-any-encoded").length, 4096);
  assert.equal(name("unstaged-any-encoded").replace(/^a+/, ""), "%4a");
  assert.equal(name("unstaged-any-short"), "a.test");
  assert.equal(name("unstaged-subdomain"), "seller-desk.localhost");
  assert.equal(name("unstaged-subdomain").slice(0, -".localhost".length).length, 11);
  // An app with Corten's default names, which answers to a name under `localhost`.
  assert.equal(cases["unstaged-subdomain"]?.hosts, undefined);
  // Host last of eight: seven browser lines before it.
  assert.equal(cases["get-any-last"]?.request(8123).latin1Slice().split("\r\n").slice(1, -2).indexOf("Host: localhost:8123"), 7);
});

test("a list of cases is refused when it names one that is not a case", () => {
  assert.deepEqual(named("get,page-browser"), ["get", "page-browser"]);
  assert.throws(() => named("get,pages"), /no case "pages"/);
  assert.throws(() => named("toString"), /no case "toString"/);
});

test("the screen must negotiate its listing, not return a fixed document or fixed JSON", () => {
  const json = '{"title":"Listing","data":{"name":"Ashen"}}';
  const doc = '<!DOCTYPE html><html lang="en"><head><title>Listing</title></head><body><main>Ashen</main></body></html>';
  const type = "Content-Type: application/json\r\n";
  const html = answer(doc, "Content-Type: text/html; charset=utf-8\r\n");
  assert.equal(screenDocument(8123).latin1Slice(), "GET /listing HTTP/1.1\r\nHost: localhost:8123\r\n\r\n");
  assert.equal(unexpectedScreenDocument(html), null);
  assert.match(String(unexpectedScreenDocument(answer(json, type))), /Content-Type/);
  assert.match(String(unexpectedScreenDocument(answer(json, "Content-Type: text/html; charset=utf-8\r\n"))), /body/);
  assert.equal(unexpected("screen-json", answer(json, type)), null);
  assert.match(String(unexpected("screen-json", html)), /Content-Type/);
  assert.match(String(unexpected("screen-json", answer(doc, type))), /body/);
  assert.match(String(unexpected("screen-json", answer(json.replace("Ashen", "Other"), type))), /body/);
  assert.match(String(unexpected("screen-json", answer(json, type, "201 Created"))), /not a 200/);
  for (const headers of ["", "content-type: text/plain\r\n", type + type.toLowerCase(), type + " extra\r\n"]) {
    assert.match(String(unexpected("screen-json", answer(json, headers))), /single Content-Type/);
  }
});

test("unencoded means no Content-Encoding field, and compressed means one zstd coding", () => {
  const plain = '{"title":"Listing","data":{"name":"Ashen"}}';
  const json = "Content-Type: application/json\r\n";
  const page = "<!DOCTYPE html><tr><td>119</td><td>A row of the page, about as long as a row of a listing is</td><td>833</td></tr></table></main></body></html>";
  const coded = zlib.zstdCompressSync(Buffer.from(page)).latin1Slice();
  const zstd = "Content-Encoding: zstd\r\n";
  assert.equal(unexpected("screen-json", answer(plain, json)), null);
  assert.equal(unexpected("page-browser", answer(coded, zstd)), null);
  for (const fields of ["Content-Encoding: gzip, br\r\n", "Content-Encoding:\t\r\n", zstd + zstd.toLowerCase(), zstd + " br\r\n", "Content-Encoding: zstd,br\r\n"]) {
    assert.match(String(unexpected("screen-json", answer(plain, json + fields))), /Content-Encoding/);
    assert.match(String(unexpected("page-browser", answer(coded, fields))), /Content-Encoding/);
  }
});

test("an answer is the case's only as a 200 with the case's body and encoding", () => {
  const row = (/** @type {number} */ n) => `<tr><td>${n}</td><td>A row of the page, about as long as a row of a listing is</td><td>${n * 7}</td></tr>`;
  const page = `<!DOCTYPE html><html lang="en"><head></head><body><main><h1>Items</h1><table>${row(118)}${row(119)}</table></main></body></html>`;
  const zstd = (/** @type {string} */ text) => zlib.zstdCompressSync(Buffer.from(text, "latin1")).latin1Slice();
  for (const [name, body] of Object.entries({
    get: "3",
    post: "23",
    "post-absolute": "23",
    unstaged: "3",
    pipeline: "ok",
    text: "ok",
    page,
    "get-browser": "3",
    "text-browser": "ok",
    "get-any": "3",
    "unstaged-any": "3",
    "get-any-last": "3",
    "unstaged-any-last": "3",
    "unstaged-any-name": "3",
    "unstaged-any-long": "3",
    "unstaged-any-encoded": "3",
    "unstaged-any-short": "3",
    "unstaged-subdomain": "3",
  })) {
    assert.equal(unexpected(name, answer(body)), null, name);
    assert.match(String(unexpected(name, answer(body, "", "404 Not Found"))), /^not a 200: HTTP\/1\.1 404 Not Found$/, name);
    assert.match(String(unexpected(name, answer(body, "", "2000 OK"))), /^not a 200/, name);
    assert.match(String(unexpected(name, answer(body, "Content-Encoding: zstd\r\n"))), /^Content-Encoding zstd, not none$/, name);
    assert.match(String(unexpected(name, answer(`${body} `))), /^not the body of /, name);
  }
  // The compressed page is the page once decompressed: not another page, not what only begins as zstd does.
  assert.equal(unexpected("page-public", answer(page, "Cache-Control: public, max-age=60\r\n")), null);
  assert.equal(unexpected("page-public", answer(page, "Cache-Control: public, max-age=60\r\naGe: 0\r\n")), "a kept public page (Age header)");
  for (const policy of ["", "Cache-Control: private, no-cache\r\n", "Cache-Control: public, max-age=60\r\nCache-Control: private\r\n"]) {
    assert.match(String(unexpected("page-public", answer(page, policy))), /Cache-Control/);
  }
  assert.equal(unexpected("page-browser", answer(zstd(page), "content-encoding: zstd\r\n")), null);
  assert.match(String(unexpected("page-browser", answer(zstd(page)))), /^Content-Encoding none, not zstd$/);
  assert.match(String(unexpected("page-browser", answer(zstd(page), "content-encoding: br\r\n"))), /^Content-Encoding br, not zstd$/);
  assert.match(String(unexpected("page-browser", answer(page, "content-encoding: zstd\r\n"))), /^not a zstd body: /);
  assert.match(String(unexpected("page-browser", answer("\x28\xb5\x2f\xfd\x00\x58", "content-encoding: zstd\r\n"))), /^not a zstd body: /);
  assert.match(String(unexpected("page-browser", answer(zstd(page.replace(row(119), "")), "content-encoding: zstd\r\n"))), /^not the body of page-browser: "<!DOCTYPE html>/);
  // The sum, not a digit of it, and the page to its last row.
  assert.match(String(unexpected("post", answer("3"))), /^not the body of post: "3"$/);
  assert.match(String(unexpected("page", answer(page.replace(row(119), "")))), /^not the body of page/);
  assert.match(String(unexpected("page", answer(`<html>${page}`))), /^not the body of page/);
});
