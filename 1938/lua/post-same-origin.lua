-- A POST to the URL on wrk's command line, from the same origin (the i1817 harness's post.lua).
wrk.method = "POST"
wrk.headers["sec-fetch-site"] = "same-origin"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
