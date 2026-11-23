-- A GET of the URL on wrk's command line with a browser's Accept-Encoding (Chrome, Firefox).
wrk.headers["accept-encoding"] = "gzip, deflate, br, zstd"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end