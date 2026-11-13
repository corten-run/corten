function hostname(authority) {
  if (!authority || /[\s\\/@?#%,]/u.test(authority)) return null;
  try {
    const host = new URL(`http://${authority}`).hostname.toLowerCase();
    return host.endsWith(".") ? host.slice(0, -1) : host;
  } catch { return null; }
}

// HOSTS names authorities, not trusted proxies. Ignore forwarding headers entirely.
export function hostFilter(config = "") {
  const hosts = ["localhost", ".localhost", "127.0.0.1", "[::1]", ...config.split(",").map((host) => host.trim()).filter(Boolean)]
    .map((value) => {
      const suffix = value.startsWith(".");
      const name = hostname(suffix ? value.slice(1) : value);
      if (!name) throw new Error("Invalid HOSTS entry");
      return { name, suffix };
    });
  return (req, res, next) => {
    const name = hostname(req.get("Host"));
    if (name && hosts.some((host) => name === host.name || host.suffix && name.endsWith(`.${host.name}`))) return next();
    res.status(400).type("text").send("Invalid Host");
  };
}
