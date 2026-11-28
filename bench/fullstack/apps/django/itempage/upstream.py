"""The connection policy every upstream client here shares."""
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3 import HTTPConnectionPool

# A pooled upstream connection idle for 4 s is closed rather than reused: every benchmark upstream
# advertises a 5 s keep-alive, and a read written to a connection as the upstream closes it is
# lost (bench/fullstack/README.md). urllib3 has no idle bound of its own; it reuses a connection
# until it has seen the server's close.
UPSTREAM_IDLE = 4.0


class _IdleBoundPool(HTTPConnectionPool):
    def _get_conn(self, timeout=None):
        conn = super()._get_conn(timeout)
        idle_since = getattr(conn, "bench_idle_since", None)
        if idle_since is not None and time.monotonic() - idle_since >= UPSTREAM_IDLE:
            # As urllib3 does for a connection it finds dropped: the next request reconnects.
            conn.close()
        return conn

    def _put_conn(self, conn):
        if conn is not None:
            conn.bench_idle_since = time.monotonic()
        super()._put_conn(conn)


class _Adapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.poolmanager.pool_classes_by_scheme = {**self.poolmanager.pool_classes_by_scheme, "http": _IdleBoundPool}


def session():
    """A requests session whose plain-HTTP connections follow UPSTREAM_IDLE."""
    result = requests.Session()
    result.mount("http://", _Adapter())
    return result
