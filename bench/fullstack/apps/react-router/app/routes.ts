import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx"), route("items/:id", "routes/item.tsx"), route("api/items/:id", "routes/api-item.ts"),
  route("live/prices", "routes/live-prices.ts"),
  route("live/publish", "routes/live-publish.ts"),
  route("catalog/:id", "routes/catalog.tsx"),
  route("api/catalog/:id", "routes/api-catalog.ts"),
  route("marketplace/:locale/:id", "routes/marketplace.tsx"),
  route("api/marketplace/:id", "routes/api-marketplace.ts"),
] satisfies RouteConfig;
