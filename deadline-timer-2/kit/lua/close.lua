-- A GET of the URL on wrk's command line that asks the server to close the connection after its
-- answer, so wrk opens a connection for each request.

wrk.headers["Connection"] = "close"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
