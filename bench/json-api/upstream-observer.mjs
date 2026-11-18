// Preloaded only in the JSON runner's two owned upstream processes. Request starts
// come from the original control body; finish is a server-side write completion,
// not a claim that the client received the response.
import { channel } from "node:diagnostics_channel";

const fresh = () => ({ completed: {}, aborted: 0 });
let responses = fresh();
channel("http.server.request.start").subscribe(({ request, response }) => {
  const path = request.url.split("?", 1)[0];
  if (path === "/__catalog/control" || path === "/__marketplace/control") {
    if (request.method === "GET") response.setHeader("X-Json-Bench-Responses", JSON.stringify(responses));
    if (request.method === "POST") response.once("finish", () => { if (response.statusCode === 200) responses = fresh(); });
  } else if (request.method === "GET" && /^\/(?:catalog\/records\/record_|marketplace\/records\/item_)[1-9]\d*$/.test(path)) {
    const epoch = responses;
    response.once("finish", () => { const code = response.statusCode; epoch.completed[code] = (epoch.completed[code] ?? 0) + 1; });
    response.once("close", () => { if (!response.writableFinished) epoch.aborted++; });
  }
});
