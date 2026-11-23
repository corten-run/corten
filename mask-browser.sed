s/^age: [0-9]*$/age: <seconds since the page was kept>/
s/^content-length: [0-9]*$/content-length: <bytes, compared by check-warm.sh>/
s/^body [0-9]*$/body <bytes, compared by check-warm.sh>/
s/^etag: W\/"[0-9a-f]*"$/etag: W\/"<keyed per process (cache.rs TAG_KEY)>"/
