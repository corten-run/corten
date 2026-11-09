// PROFILE=matched at build: the matched tier's production profile (bench/fullstack/README.md, "The
// matched tier"). Next.js fixes its config when it builds, so the image builds the app twice, without
// the profile and with it, and starts the one PROFILE names (Dockerfile).
const matched = process.env.PROFILE === "matched";

// axum-maud's headers. The pages' CSP is proxy.matched.ts's, with a nonce for each response.
const security = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" },
];
const api = [
  { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" },
  { key: "Cache-Control", value: "private, no-cache" },
];

/** @type {import("next").NextConfig} */
export default {
  output: "standalone",
  poweredByHeader: false,
  ...(matched && {
    // proxy.matched.ts is the app's Proxy only in this build.
    pageExtensions: ["matched.ts", "tsx", "ts", "jsx", "js"],
    // The edge sends the app its container name as Host, so the origin a browser posts from there
    // is allowed by name (EDGE_HOST, the Dockerfile's), as a deploy names its own domain.
    experimental: { serverActions: { allowedOrigins: [process.env.EDGE_HOST ?? ""].filter(Boolean) } },
    async headers() {
      return [
        { source: "/:path*", headers: security },
        { source: "/api/:path*", headers: api },
      ];
    },
  }),
};
