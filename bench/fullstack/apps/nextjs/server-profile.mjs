import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
};

export function contentSecurityPolicy(nonce) {
  // 'self' also permits Next's external scripts on its statically built error pages.
  return `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
}

function hostname(authority) {
  if (typeof authority !== "string" || !authority || /[\s/\\@?#,]/.test(authority)) return null;
  try {
    const name = new URL("http://" + authority).hostname.toLowerCase();
    return /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])$/.test(name) ? name : null;
  }
  catch { return null; }
}

// Next's documented custom-server entry point leaves rendering and routing to Next.
// Node owns admission and HTTP parsing deadlines; no extra proxy or renderer is involved.
export function productionServer(handle, env = process.env) {
  const matched = env.PROFILE === "matched";
  const hosts = (env.HOSTS ?? "localhost,127.0.0.1,[::1]").split(",").map((h) => hostname(h.trim()));
  if (matched && hosts.some((h) => !h)) throw new Error("HOSTS must contain explicit valid host names");
  const maxConnections = Number(env.MAX_CONNECTIONS ?? 1000);
  if (matched && (!Number.isSafeInteger(maxConnections) || maxConnections < 1)) {
    throw new Error("MAX_CONNECTIONS must be a positive integer");
  }
  const server = createServer(matched ? {
    maxHeaderSize: 16 * 1024,
    headersTimeout: 30_000,
    requestTimeout: 30_000,
    connectionsCheckingInterval: 1000,
  } : {}, async (req, res) => {
    if (matched) {
      for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Security-Policy", contentSecurityPolicy());
      if (!hosts.includes(hostname(req.headers.host))) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
        res.end("Unrecognized Host");
        return;
      }
      // Never trust a client-supplied nonce or policy. Both router families get a server nonce;
      // Pages reads x-nonce in _document; App Router reads the request's CSP automatically.
      const nonce = randomBytes(16).toString("base64");
      req.headers["x-nonce"] = nonce;
      req.headers["content-security-policy"] = contentSecurityPolicy(nonce);
      res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce));
      if (req.url?.split("?")[0] === "/health/live") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { Allow: "GET, HEAD" });
          res.end();
        } else {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(req.method === "HEAD" ? undefined : "ok");
        }
        return;
      }
    }
    try { await handle(req, res); }
    catch (error) {
      console.error(error);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Internal Server Error");
      }
    }
  });
  if (matched) server.maxConnections = maxConnections;
  return server;
}
