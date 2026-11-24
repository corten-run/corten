-- A GET of the URL on wrk's command line with the headers of a same-origin fetch from Firefox.

wrk.headers["User-Agent"] = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"
wrk.headers["Accept"] = "*/*"
wrk.headers["Accept-Language"] = "en-US,en;q=0.5"
wrk.headers["Accept-Encoding"] = "gzip, deflate, br, zstd"
wrk.headers["Sec-Fetch-Dest"] = "empty"
wrk.headers["Sec-Fetch-Mode"] = "cors"
wrk.headers["Sec-Fetch-Site"] = "same-origin"

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
