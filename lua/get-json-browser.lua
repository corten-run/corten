-- A GET of the URL on wrk's command line as a data client with a browser's codings asks for JSON:
-- Accept: application/json and Accept-Encoding: gzip, deflate, br, zstd (#1846's JSON case).
wrk.headers["accept"] = "application/json"
wrk.headers["accept-encoding"] = "gzip, deflate, br, zstd"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
