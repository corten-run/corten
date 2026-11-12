// PROFILE=matched at build: the matched tier's production profile (bench/fullstack/README.md, "The
// matched tier"). Next.js fixes its config when it builds, so the matched tier builds its own image
// (the Dockerfile's PROFILE build argument).
const matched = process.env.PROFILE === "matched";

/** @type {import("next").NextConfig} */
export default {
  // A documented custom server cannot use Next's standalone server output.
  poweredByHeader: false,
  // Inline the build profile in server components, including the not-found layout.
  env: { PROFILE: matched ? "matched" : "" },
  ...(matched && {
    // proxy.matched.ts is the app's Proxy only in this build.
    pageExtensions: ["matched.ts", "tsx", "ts", "jsx", "js"],
    // The edge sends the app its container name as Host, so the origin a browser posts from there
    // is allowed by name (EDGE_HOST, the Dockerfile's), as a deploy names its own domain.
    experimental: { serverActions: { allowedOrigins: [process.env.EDGE_HOST ?? ""].filter(Boolean) } },
  }),
};
