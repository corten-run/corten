import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { captureSource, control } from "./capture.mjs";
import { nativeTransport } from "./native.mjs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { plan, records, app, source, base, upstream, settings, folder, readbackPath } = config;
const token = process.env.MIXED_CONTROL_TOKEN;
const browser = await chromium.launch({ headless: true });
let transport;
const save = (name, value) => {
  const path = join(folder, name);
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
};
try {
  transport = await nativeTransport({ browser, base, settings, readbackPath });
  const result = await captureSource({ plan, records, app, source, transport, settings,
    injector: { begin: (id, mode, delayMs) => control(upstream, token, id, { mode, delayMs }), read: (id) => control(upstream, token, id) },
    save: async (request, evidence) => save(`${request.id}.json`, evidence),
  });
  save("capture.json", result);
} finally { await transport?.close(); await browser.close(); }
