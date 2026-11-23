-- A GET of the URL on wrk's command line as a client that accepts gzip and brotli and not zstd.

wrk.headers["Accept-Encoding"] = "gzip, br"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
