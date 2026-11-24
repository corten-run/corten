#!/usr/bin/env bash
# Records the Accept-Encoding line Playwright's Chromium, Firefox and WebKit send for a page
# opened over plain HTTP and over HTTPS (a self-signed certificate for localhost).
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive PATH=/root/node/bin:$PATH
for i in $(seq 1 60); do
    if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; then sleep 5; else break; fi
done
if [ ! -x /root/node/bin/node ]; then
    V=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -oP 'node-v[0-9.]+-linux-x64\.tar\.xz' | head -1)
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$V" -o /root/node.tar.xz
    mkdir -p /root/node && tar -xJf /root/node.tar.xz -C /root/node --strip-components=1 && rm /root/node.tar.xz
fi
mkdir -p /root/ae && cd /root/ae
[ -d node_modules/playwright ] || npm i playwright >npm.log 2>&1
npx playwright install --with-deps chromium firefox webkit >install.log 2>&1 || { tail -5 install.log; echo "AE-FAILED install"; exit 1; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=localhost -addext subjectAltName=DNS:localhost >/dev/null 2>&1
cat >probe.mjs <<'EOF'
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";
const seen = [];
const answer = (scheme) => (req, res) => {
  if (req.url === "/page") seen.push([scheme, req.headers["user-agent"], req.headers["accept-encoding"], req.headers["accept"]]);
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>t</title><p>page");
};
const plain = http.createServer(answer("http")).listen(18090);
const tls = https.createServer({ key: readFileSync("key.pem"), cert: readFileSync("cert.pem") }, answer("https")).listen(18443);
for (const [name, kind] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  const browser = await kind.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  for (const url of ["http://localhost:18090/page", "https://localhost:18443/page"]) {
    const before = seen.length;
    await page.goto(url);
    for (const row of seen.slice(before)) console.log(JSON.stringify({ browser: name, version: browser.version(), scheme: row[0], acceptEncoding: row[2], accept: row[3], userAgent: row[1] }));
  }
  await browser.close();
}
plain.close(); tls.close();
EOF
node probe.mjs >lines.jsonl 2>probe.err || { cat probe.err; echo "AE-FAILED probe"; exit 1; }
cat lines.jsonl
echo "playwright $(node -e 'console.log(require("playwright/package.json").version)')"
echo AE-DONE
