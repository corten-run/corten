import { productionServer } from "./server-profile.mjs";
import { readFile } from "node:fs/promises";

const { config } = JSON.parse(await readFile(new URL("./.next/required-server-files.json", import.meta.url), "utf8"));
if (config.env.PROFILE !== (process.env.PROFILE === "matched" ? "matched" : "")) {
  throw new Error("PROFILE must match the Next build profile; rebuild before changing profiles");
}

// Next and React select their runtime while loading, before next({ dev: false }) runs.
process.env.NODE_ENV = "production";
const { default: next } = await import("next");

const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8080);
const app = next({ dev: false, hostname, port });
await app.prepare();
const server = productionServer(app.getRequestHandler());
// Do not put a smaller pending-connection queue in front of the matched admission limit.
server.listen({ port, host: hostname, backlog: server.maxConnections },
  () => console.log(`Next.js listening on ${hostname}:${port}`));

let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  server.close();
  server.closeAllConnections();
  await app.close();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
