import { createServer } from "node:http";
import { createHash } from "node:crypto";

// A loopback WebSocket peer for hostile probes, not application evidence.
export async function socketFixture() {
  const sockets = new Set();
  let receivedBytes = 0, closing;
  const server = createServer((req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (bytes) => { receivedBytes += bytes.length; });
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise((ok, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", ok); });
  return { url: `ws://127.0.0.1:${server.address().port}/`, receivedBytes: () => receivedBytes,
    close: () => closing ??= new Promise((ok) => { for (const socket of sockets) socket.destroy(); server.close(ok); }) };
}
