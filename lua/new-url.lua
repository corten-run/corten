-- A GET of a URL not asked for before: the path on wrk's command line (wrk.path, /page or /records)
-- and ?s=<seconds at the turn's start>&t=<wrk thread>&n=<counter, seven digits>, every URL the
-- same length. No Accept-Encoding, as get.lua.
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
    return wrk.format(nil, prefix .. string.format("%07d", n))
end
done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
end