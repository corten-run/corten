// The page's fetch belongs to the response, not IncomingMessage's completed request body.
export function requestLifetime(req, res, next) {
  const controller = new AbortController();
  const timedout = () => {
    controller.abort(new DOMException("Marketplace request timed out", "TimeoutError"));
    if (!req.complete && !res.headersSent && !res.destroyed) {
      // Connection: close lets Node flush the timeout response and close the
      // transport. Destroying IncomingMessage on 'finish' can reset that socket
      // before the peer receives any response bytes.
      const socket = req.socket;
      res.once("finish", () => socket.end(() => req.destroy()));
      res.set("Connection", "close").status(req.timedout ? 503 : 504).type("text").send("Marketplace request timed out");
    }
  };
  const deadline = setTimeout(timedout, 10000);
  const cleanup = () => {
    clearTimeout(deadline);
    req.off("timeout", timedout);
    res.off("finish", cleanup);
    res.off("close", disconnected);
  };
  const disconnected = () => {
    if (!res.writableEnded) controller.abort();
    cleanup();
  };
  req.once("timeout", timedout);
  res.once("finish", cleanup);
  res.once("close", disconnected);
  res.locals.requestSignal = controller.signal;
  res.locals.marketplaceTraceparent = req.get("traceparent");
  next();
}

// body-parser selects its native decompressor synchronously by piping req into
// it. A source destroy does not cancel a pipe destination. Observe only that
// selection, then restore the request method before returning to the event loop.
export function readForm(form, req, res, next) {
  const signal = res.locals.requestSignal;
  const readers = new Set();
  const descriptor = Object.getOwnPropertyDescriptor(req, "pipe");
  const pipe = req.pipe;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (descriptor) Object.defineProperty(req, "pipe", descriptor);
    else delete req.pipe;
  };
  const cancelled = () => {
    for (const reader of readers) {
      req.unpipe(reader);
      reader.destroy(signal.reason);
    }
  };
  signal.addEventListener("abort", cancelled, { once: true });
  req.pipe = function (reader, ...args) {
    readers.add(reader);
    return pipe.call(this, reader, ...args);
  };
  const cleanup = () => {
    signal.removeEventListener("abort", cancelled);
    readers.clear();
  };
  try {
    form(req, res, (error) => {
      restore();
      cleanup();
      // A cancelled parser must not resume routing after the timeout response.
      if (!signal.aborted && !res.destroyed && !req.timedout) next(error);
    });
    if (signal.aborted) cancelled();
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    restore();
  }
}
