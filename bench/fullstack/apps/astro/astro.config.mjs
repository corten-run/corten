import node from "@astrojs/node";
import { defineConfig } from "astro/config";

// Every page rendered on request by the Node adapter's own server.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // The benchmark's browser reaches this native server through loopback.
  // Keep Host validation and the native CSRF check, admitting only these hosts.
  security: { allowedDomains: [{ hostname: "localhost" }, { hostname: "127.0.0.1" }, { hostname: "[::1]" }] },
});
