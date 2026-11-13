import https from 'node:https';
import http2 from 'node:http2';
import assert from 'node:assert/strict';
const [protocol, countText, kind = 'page'] = process.argv.slice(2);
const count = Number(countText);
const path = kind === 'events' ? `/events?n=${count}` : '/';
const requests = kind === 'events' ? 1 : count;
let total = 0;
if (protocol === 'h2') {
  const client = http2.connect('https://localhost:18590', { rejectUnauthorized: false });
  try {
    for (let n = 0; n < requests; n++) {
      await new Promise((resolve, reject) => {
        const request = client.request({ ':path': path, 'accept-encoding': 'identity' });
        request.on('response', headers => assert.equal(headers[':status'], 200));
        request.on('data', chunk => { total += chunk.length; });
        request.on('end', resolve);
        request.on('error', reject);
        request.end();
      });
    }
  } finally { client.close(); }
} else {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  try {
    for (let n = 0; n < requests; n++) {
      await new Promise((resolve, reject) => {
        const request = https.get(`https://localhost:18590${path}`, { agent, headers: { 'accept-encoding': 'identity' } }, response => {
          assert.equal(response.statusCode, 200);
          response.on('data', chunk => { total += chunk.length; });
          response.on('end', resolve);
          response.on('error', reject);
        });
        request.on('error', reject);
      });
    }
  } finally { agent.destroy(); }
}
console.log(JSON.stringify({ protocol, kind, count, requests, bytes: total }));
