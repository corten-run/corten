// node --test bench/request-cost/requests.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { Answers, cases, deep, masked, median, named } from "./requests.mjs";

const answer = (/** @type {string} */ body, more = "") => Buffer.from(`HTTP/1.1 200 OK\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${more}\r\n${body}`, "latin1");

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

test("each case is one whole request to its port", () => {
  for (const [name, { request }] of Object.entries(cases)) {
    const text = request(8123).latin1Slice();
    assert.match(text, /^(GET|POST) \/\S* HTTP\/1\.1\r\nHost: localhost:8123\r\n/, name);
    const [head, body] = /** @type {[string, string]} */ (text.split("\r\n\r\n"));
    const length = /^Content-Length: (\d+)$/m.exec(head);
    assert.equal(body.length, length ? Number(length[1]) : 0, name);
  }
  const lines = (/** @type {string} */ name) => /** @type {typeof cases[string]} */ (cases[name]).request(8080).latin1Slice().split("\r\n").length;
  assert.equal(lines("get-browser"), lines("get") + 7);
});

test("a list of cases is refused when it names one that is not a case", () => {
  assert.deepEqual(named("get,page-browser"), ["get", "page-browser"]);
  assert.deepEqual(named(deep.join(",")), deep);
  assert.throws(() => named("get,pages"), /no case "pages"/);
  assert.throws(() => named("toString"), /no case "toString"/);
});

test("the median of three counts is the middle one", () => {
  assert.equal(median([19175, 19169, 19171]), 19171);
  assert.equal(median([5]), 5);
});
