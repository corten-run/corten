"""The limits every upstream client here shares (catalog, marketplace and item API)."""
import httpx

# How long a connection to an upstream may sit idle in the pool before a request opens a new one
# instead. Each upstream (the catalog, marketplace and item API fixtures, all Node HTTP servers)
# answers `Keep-Alive: timeout=5` and closes a connection idle for those 5 s plus Node's 1 s
# buffer; a request written to a pooled connection as it closes is lost. httpx keeps an idle
# connection 5 s by default, as long as the upstream advertises, so the pool drops one a second
# under it. It adds no retry: each read is still one upstream GET.
UPSTREAM_IDLE = 4.0

# No cap on connections to an upstream, as bench/fullstack/README.md's item API rule asks.
LIMITS = httpx.Limits(max_connections=None, max_keepalive_connections=None, keepalive_expiry=UPSTREAM_IDLE)