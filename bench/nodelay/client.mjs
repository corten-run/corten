// Opens each URL (a live stream of ten small events) REPEAT times in a row, URL after URL, ROUNDS
// rounds, the URLs' order reversed every other round; each stream on a new connection to the proxy,
// which reuses one connection to the app. Prints a JSON line per stream: its URL, its place in its
// block (`k`: 0 is the first after the app's connection sat idle while the other URLs ran), when
// its headers arrived after the request was sent (`head`), when each event arrived after the
// headers (`arrived`), and when the app made each after the first (`made`), in milliseconds.
// The client only reads, so its own TCP_NODELAY does not matter.
// Usage: node client.mjs <rounds> <repeat> <url>...
import http from "node:http";

const [rounds, repeat, ...urls] = process.argv.slice(2);
const agent = new http.Agent({ keepAlive: false });

function once(url, k) {
  return new Promise((resolve, reject) => {
    const arrived = [];
    const made = [];
    let buffer = "";
    const sent = performance.now();
    let head;
    const req = http.get(url, { agent, headers: { accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${url}: status ${res.statusCode}`));
      head = performance.now();
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        const now = performance.now();
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const tick = /<p id="[^"]*">(\d+) (\d+)<\/p>/.exec(event);
          if (tick) {
            arrived.push(now);
            made.push(Number(tick[2]) / 1000);
          }
        }
      });
      res.on("end", () => resolve({ url, k, head: +(head - sent).toFixed(3), arrived: arrived.map((t) => +(t - head).toFixed(3)), made }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

for (let round = 0; round < Number(rounds); round += 1) {
  for (const url of round % 2 ? [...urls].reverse() : urls) {
    for (let k = 0; k < Number(repeat); k += 1) console.log(JSON.stringify(await once(url, k)));
  }
}
