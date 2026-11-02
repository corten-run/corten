import type { RouterConfig } from "@nuxt/schema";

// Corten's links carry no class for the current page; vue-router's defaults would add two.
export default {
  linkActiveClass: "",
  linkExactActiveClass: "",
} satisfies RouterConfig;
