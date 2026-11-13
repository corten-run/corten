// Environment-independent app identities shared by legacy and workload registries.
// `pages: false` is JSON-only; matched flags/images retain their legacy tier meaning.
// `matched: true` apps start with PROFILE=matched. Next.js fixes config at build
// time and uses matchedImage, built with --build-arg PROFILE=matched. In that tier
// `matchedJson: false` leaves JSON phases to the separate aspnet-aot app.
const catalog = {
  corten: { image: "cb-corten", port: 18410, label: "Corten 0.1 (Rust, axum, html! views)", matched: true },
  nextjs: { image: "cb-nextjs", port: 18411, label: "Next.js 16.4 (App Router, RSC)", matched: true, matchedImage: "cb-nextjs-matched" },
  "tanstack-start": { image: "cb-tanstack-start", port: 18412, label: "TanStack Start 1.169 (React 19, Nitro)" },
  sveltekit: { image: "cb-sveltekit", port: 18413, label: "SvelteKit 3.1 (Svelte 5, adapter-node)" },
  "react-router": { image: "cb-react-router", port: 18414, label: "React Router 7.18 + Express" },
  leptos: { image: "cb-leptos", port: 18415, label: "Leptos 0.8 (Rust, SSR + WASM hydration)", matched: true },
  django: { image: "cb-django", port: 18416, label: "Django 6.1 (Python, gunicorn, htmx)" },
  rails: { image: "cb-rails", port: 18417, label: "Rails 8.1 (Ruby, Puma, YJIT, Turbo)" },
  laravel: { image: "cb-laravel", port: 18418, label: "Laravel 13 (PHP, Octane on FrankenPHP, Livewire)" },
  aspnet: { image: "cb-aspnet", port: 18419, label: "ASP.NET Core 10 Razor Pages (C#, Kestrel, htmx)", matched: true, matchedJson: false },
  spring: { image: "cb-spring", port: 18420, label: "Spring Boot 4.1 (Java 25, Thymeleaf, htmx)" },
  phoenix: { image: "cb-phoenix", port: 18421, label: "Phoenix 1.8 LiveView (Elixir)" },
  astro: { image: "cb-astro", port: 18422, label: "Astro 7 (Node adapter, client router)" },
  nuxt: { image: "cb-nuxt", port: 18423, label: "Nuxt 4 (Vue 3, Nitro)" },
  topcoat: { image: "cb-topcoat", port: 18424, label: "Topcoat 0.11 (Rust, view! components, shards)", matched: true },
  "axum-maud": { image: "cb-axum-maud", port: 18427, label: "axum 0.8 + Maud 0.27 (Rust, htmx)", matched: true },
  gin: { image: "cb-gin", port: 18425, label: "Gin 1.12 (Go, templ, htmx)" },
  drogon: { image: "cb-drogon", port: 18426, label: "Drogon 1.9 (C++, CSP views, htmx)" },
  fastapi: { image: "cb-fastapi", port: 18429, label: "FastAPI 0.162 (Python, uvicorn, Jinja2, htmx)", matched: true },
  express: { image: "cb-express", port: 18430, label: "Express 5.3 (Node, EJS, htmx)", matched: true },
  "aspnet-aot": { image: "cb-aspnet-aot", port: 18428, label: "ASP.NET Core 10 minimal API, native AOT (C#, JSON only)", pages: false, matched: true },
};
Object.values(catalog).forEach(Object.freeze);
export const allApps = Object.freeze(catalog);
