import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// Keep the legacy benchmark origin unless a separate workload supplies its own at build time.
// adapter-node uses this same origin for request URLs and SvelteKit's native CSRF checks.
export default defineConfig({ plugins: [sveltekit({ adapter: adapter(), paths: {
  origin: process.env.BENCHMARK_ORIGIN ?? "http://localhost:18413",
} })] });
