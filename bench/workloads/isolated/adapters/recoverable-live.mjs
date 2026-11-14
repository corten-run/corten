import { inspectLiveSaved } from "./live-delivery.mjs";

export async function inspectSaved(binding, folder) {
  return inspectLiveSaved(binding, folder, "recoverable-live");
}
