export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/catalog");
    await import("./lib/marketplace-server");
  }
}
