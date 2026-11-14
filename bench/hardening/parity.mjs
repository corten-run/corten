// Same complete native browser/content gate, with private fixture and TLS-origin support.
import { readFileSync, writeFileSync } from "node:fs";
import { X509Certificate, createHash } from "node:crypto";
import { checkApp } from "../marketplace/check.mjs";
import { verifyParity } from "./evidence.mjs";
const [base, source, upstream, output] = process.argv.slice(2);
const { chromium } = await import("@playwright/test");
const certificate = process.env.BENCH_EDGE_CERT ? new X509Certificate(readFileSync(process.env.BENCH_EDGE_CERT)) : null;
const pin = certificate ? createHash("sha256").update(certificate.publicKey.export({ type: "spki", format: "der" })).digest("base64") : null;
const browser = await chromium.launch({ headless: true, args: pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [] });
try {
  const catalog = JSON.parse(readFileSync("/fixtures/marketplace.json", "utf8"));
  const result = await checkApp({ base, source, upstream, catalog, browser }); verifyParity(result, source);
  writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
