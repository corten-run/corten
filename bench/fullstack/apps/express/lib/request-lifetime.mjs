// The page's fetch belongs to the response, not IncomingMessage's completed request body.
export function requestLifetime(req, res, next) {
  const controller = new AbortController();
  const timedout = () => controller.abort(new DOMException("Marketplace request timed out", "TimeoutError"));
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
  next();
}
