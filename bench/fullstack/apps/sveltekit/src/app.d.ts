import type { MarketplaceRecord } from "./lib/marketplace";

declare global {
  namespace App {
    interface Locals {
      marketplaceAlertRecord?: MarketplaceRecord;
    }
  }
}
export {};
