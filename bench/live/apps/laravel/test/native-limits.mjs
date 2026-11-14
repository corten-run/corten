import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const base = process.argv[2];
assert.ok(base);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(base);
  const actual = await page.evaluate(async () => {
    const socket = new WebSocket(location.origin.replace('http', 'ws') + '/app/' +
      document.querySelector('meta[name="reverb-key"]').content + '?protocol=7&client=js&version=8.4.0&flash=false');
    const frames = [];
    let receive;
    socket.onmessage = event => { const frame = JSON.parse(event.data); frames.push(frame); receive?.(frame); };
    async function next(send) {
      let timer;
      try { return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('native control deadline')), 2000);
        receive = resolve; send?.();
      }); } finally { clearTimeout(timer); receive = null; }
    }
    try {
      await next();
      for (let n = 0; n < 17; n++) await next(() => socket.send(JSON.stringify({ event: 'pusher:subscribe',
        data: { channel: 'live.' + n.toString(16).padStart(64, '0') } })));
      return { subscribed: frames.filter(frame => frame.event === 'pusher_internal:subscription_succeeded').map(frame => frame.channel),
        errors: frames.filter(frame => frame.event === 'pusher:error') };
    } finally { socket.close(1000); }
  });
  console.log(JSON.stringify(actual));
  assert.equal(actual.subscribed.length, 16, 'native broker allocated a seventeenth channel before application cap validation');
  assert.equal(actual.errors.length, 1);
  await page.waitForFunction(async () => {
    const resources = await fetch('/parity/resources').then(response => response.json());
    return resources.connections === 0 && resources.subscriptions === 0 && resources.pendingTasks === 0;
  }, null, { timeout: 5000 });
  console.log('Laravel real native broker channel cap and socket cleanup: passed');
} finally { await browser.close(); }
