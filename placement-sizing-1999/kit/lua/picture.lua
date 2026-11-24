-- A GET of the URL on wrk's command line with the two header lines #1964's load sent (no coding
-- named, any type), which the driver's own requests send as well.
wrk.headers["Accept-Encoding"] = "identity"
wrk.headers["Accept"] = "*/*"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
