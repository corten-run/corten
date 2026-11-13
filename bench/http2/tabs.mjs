import { chromium, firefox, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
const name = process.argv[2] ?? 'chromium';
const browser = await ({ chromium, firefox, webkit })[name].launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const pages = [];
  const results = [];
  for (let i = 0; i < 8; i++) {
    const page = await context.newPage();
    const streams = new Set();
    page.on('response', response => {
      if (response.headers()['content-type']?.includes('text/event-stream')) streams.add(new URL(response.url()).pathname);
    });
    const started = performance.now();
    const response = await page.goto('https://localhost:18590/', { timeout: 15000 });
    assert.equal(response.status(), 200);
    const protocol = await page.evaluate(() => performance.getEntriesByType('navigation')[0].nextHopProtocol);
    assert.equal(protocol, 'h2');
    const ms = Math.round(performance.now() - started);
    await page.waitForFunction(() => document.querySelector('#prices [data-ref="updates"]')?.textContent?.match(/[1-9]/), undefined, { timeout: 15000 });
    pages.push(page);
    results.push({ tab: i + 1, ms, protocol, streams });
  }
  const before = await Promise.all(pages.map(page => page.locator('corten-live').first().innerText()));
  for (let i = 0; i < pages.length; i++) {
    await pages[i].waitForFunction(text => document.querySelector('corten-live')?.textContent.trim() !== text.trim(), before[i], { timeout: 10000 });
    assert(results[i].streams.has('/live/trades'));
    assert(results[i].streams.has('/feed/stocks/live'));
  }
  console.log(JSON.stringify({ engine: name, version: browser.version(), tabs: results.map(x => ({ ...x, streams: [...x.streams], liveChanged: true })) }));
} finally {
  await browser.close();
}
