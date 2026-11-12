// Only the two record JSON endpoints own this read; page/profile behavior stays separate.
export function recordJson(read) {
  return async (req, res) => {
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    const timedout = () => controller.abort(new DOMException("Record read timed out", "TimeoutError"));
    const deadline = setTimeout(timedout, 10000);
    res.once("close", disconnected);
    req.once("timeout", timedout);
    res.set("Cache-Control", "no-store");
    try {
      const record = await read(req.params.id, { signal: controller.signal });
      if (res.destroyed || res.headersSent || req.timedout) return;
      if (!record) return res.status(404).json({ error: "record not found" });
      res.json(record);
    } catch {
      if (res.destroyed || res.headersSent || req.timedout) return;
      const status = controller.signal.reason?.name === "TimeoutError" ? 504 : 502;
      res.status(status).json({ error: status === 504 ? "record source timed out" : "record source unavailable" });
    } finally {
      clearTimeout(deadline);
      res.off("close", disconnected);
      req.off("timeout", timedout);
    }
  };
}

export function recordMethod(req, res) {
  res.set({ Allow: "GET, HEAD", "Cache-Control": "no-store" }).status(405).json({ error: "method not allowed" });
}

// connect-timeout's matched-profile error can arrive outside the async route handler.
export function recordError(error, req, res, next) {
  if (!/^\/api\/(catalog|marketplace)\/[^/]+\/?$/i.test(req.path) || res.headersSent) return next(error);
  const status = error.timeout ? 503 : error.status >= 400 && error.status < 500 ? error.status : 502;
  if (!res.destroyed) res.set("Cache-Control", "no-store").status(status).json({ error: "record request failed" });
}
