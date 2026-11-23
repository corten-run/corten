// App code for the generated service worker, loaded first by it (corten::pwa::Pwa::import_script).
// A push message is JSON: {"title", "body", "url"}. Sending one (VAPID keys, payload encryption,
// stored subscriptions) is the server's job; this file only shows it and opens the page on click.
// The scripts are checked with the page's DOM types, where `self` is a window, not a worker's:
// what this uses of the worker's global and events is declared here.
/** @typedef {Event & { waitUntil(promise: Promise<unknown>): void }} ExtendableEvent */
const worker = /** @type {typeof globalThis & { registration: { showNotification(title: string, options: { body?: string, data: { url: string } }): Promise<void> }, clients: { openWindow(url: string): Promise<unknown> } }} */ (/** @type {unknown} */ (self));

worker.addEventListener("push", (e) => {
  const event = /** @type {ExtendableEvent & { data: { json(): unknown } | null }} */ (e);
  // The app's own server sent it, but a message from an older version may still be queued.
  const json = event.data?.json();
  const data = /** @type {{ title?: unknown, body?: unknown, url?: unknown }} */ (typeof json === "object" && json !== null ? json : {});
  const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : undefined);
  event.waitUntil(worker.registration.showNotification(text(data.title) ?? "", { body: text(data.body), data: { url: text(data.url) ?? "/" } }));
});

worker.addEventListener("notificationclick", (e) => {
  // Its data is what showNotification above was given.
  const event = /** @type {ExtendableEvent & { notification: { close(): void, data: { url: string } } }} */ (e);
  event.notification.close();
  event.waitUntil(worker.clients.openWindow(event.notification.data.url));
});
