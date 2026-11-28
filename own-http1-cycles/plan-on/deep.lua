-- 16 GETs of the URL on wrk's command line written at a time on each connection.
init = function(args)
    local r = {}
    for i = 1, 16 do r[i] = wrk.format() end
    req = table.concat(r)
end

request = function()
    return req
end

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end
