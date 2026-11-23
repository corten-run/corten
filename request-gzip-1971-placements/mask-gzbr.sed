s/^content-encoding: .*$/content-encoding: <the coding, which the change alters>/
s/^content-length: [0-9]*$/content-length: <the coded length, which the change alters>/
s/^etag: W\/"[0-9a-f]*"$/etag: W\/"<keyed per process start>"/
