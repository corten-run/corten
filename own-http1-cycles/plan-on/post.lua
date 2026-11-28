-- A POST of the URL on wrk's command line with a 2-byte text/plain body, as bench/request-cost sends its post case.
wrk.method = "POST"
wrk.body = "20"
wrk.headers["Content-Type"] = "text/plain"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
