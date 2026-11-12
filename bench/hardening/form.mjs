// Preflight actual native form action/token/cookie and a successful body on this exact deployment.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { formOf, formBody } from "../fullstack/conformance.mjs";
const [serialized, output] = process.argv.slice(2), target = JSON.parse(serialized);
const send = (path, method = "GET", headers = {}, body) => new Promise((resolve, reject) => {
  const req = (target.tls ? httpsRequest : httpRequest)({ host: target.host, port: target.port, path, method, agent: false, ca: target.caPem,
    headers: { host: target.authority, origin: target.origin, "sec-fetch-site": "same-origin", ...headers } }, (res) => {
    const parts = []; res.on("data", (c) => parts.push(c)); res.on("error", reject);
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }));
  });
  const timer = setTimeout(() => req.destroy(new Error("native form preflight timeout")), 5000);
  req.on("error", reject); req.on("close", () => clearTimeout(timer)); req.end(body);
});
const path = "/marketplace/en-US/item_1", page = await send(path); assert.equal(page.status, 200);
const form = formOf(page.body, path); assert.ok(form && !form.script, "native POST form required");
const cookie = (page.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).join("; ");
const body = formBody(form); assert.ok(body.type.startsWith("application/x-www-form-urlencoded"), "unsupported native form encoding; do not fake a body attack");
const accepted = await send(form.path, "POST", { cookie, "content-type": body.type, "content-length": Buffer.byteLength(body.body) }, body.body);
assert.ok(accepted.status >= 200 && accepted.status < 400, "native form submission did not reach a healthy handler");
writeFileSync(output, JSON.stringify({ path: form.path, cookie, type: body.type, prefix: body.body + "&padding=", preflightStatus: accepted.status }));
console.log(JSON.stringify({ path: form.path, encoding: body.type, preflightStatus: accepted.status }));
