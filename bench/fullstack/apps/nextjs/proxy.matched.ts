import { NextResponse, type NextRequest } from "next/server";

// The matched tier's CSP for the pages (next.config.mjs has the other headers), as Next.js's Content
// Security Policy guide sets it: a nonce for each response, which Next.js reads from the request's
// policy and writes on its scripts. axum-maud's policy with the nonce added.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data: https:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

// The guide's matcher: not the JSON (next.config.mjs gives it a fixed policy), the static files or
// a link's prefetch.
export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
