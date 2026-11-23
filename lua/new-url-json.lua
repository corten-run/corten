-- A GET of a URL not asked for before, as a data client asks: new-url.lua's URLs (the path on wrk's
-- command line, /records, and ?s=<seconds>&t=<thread>&n=<seven digits>) with Accept:
-- application/json, the 1846r kit's way of asking for /records. No Accept-Encoding.
local threads = 0

function setup(thread)
    threads = threads + 1
    thread:set("id", threads)
end

function init(args)
    prefix = wrk.path .. "?s=" .. os.time() .. "&t=" .. id .. "&n="
    n = 0
end

function request()
    n = n + 1
    return wrk.format(nil, prefix .. string.format("%07d", n), { ["Accept"] = "application/json" })
end
done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end