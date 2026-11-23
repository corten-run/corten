-- Every URL asked twice, with a browser's Accept-Encoding (Chrome, Firefox) (1846r5's `twice`): a
-- URL not asked for before, and later the same URL once more, which on #1846's head is its second
-- compressed answer and queues its brotli 5. The path on wrk's command line (wrk.path, /page) and
-- ?s=<seconds at the turn's start>&t=<wrk thread>&n=<URL, seven digits>, every URL the same length.
-- A thread's requests go in blocks of 2 x LAG: URLs b*LAG to b*LAG+LAG-1 asked once each, then the
-- same URLs again in the same order, so a URL's second request is made LAG requests after its
-- first on that thread. wrk sends a connection's next request only once its last answer came (no
-- pipelining), so with 32 connections a thread, at least LAG - 32 of the thread's answers came
-- after the first was sent and before the second was made.
-- response() counts the answers with an Age (kept answers: the second of each URL) and without
-- (made: the first), and done() prints, for each thread, "AGED <thread> <first requests made>
-- <second requests made> <answers with an Age> <answers without>" beside RESULT. gate.mjs checks
-- them: no more answers of either kind than requests of that kind, no more than a thread's 32
-- connections' requests unanswered at the end, and the answers summing to RESULT's requests; so
-- at most 32 second requests a thread can have been made again rather than given kept.
wrk.headers["accept-encoding"] = "gzip, deflate, br, zstd"
local LAG = 256
local threads = {}

function setup(thread)
    table.insert(threads, thread)
    thread:set("id", #threads)
end

function init(args)
    prefix = wrk.path .. "?s=" .. os.time() .. "&t=" .. id .. "&n="
    n = 0
    firsts = 0
    seconds = 0
    aged = 0
    made = 0
end

function request()
    local url = math.floor(n / (2 * LAG)) * LAG + n % LAG
    if n % (2 * LAG) < LAG then firsts = firsts + 1 else seconds = seconds + 1 end
    n = n + 1
    return wrk.format(nil, prefix .. string.format("%07d", url))
end

function response(status, headers, body)
    if headers["age"] ~= nil or headers["Age"] ~= nil then aged = aged + 1 else made = made + 1 end
end

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
    for _, thread in ipairs(threads) do
        io.write(string.format("AGED %d %d %d %d %d\n", thread:get("id"), thread:get("firsts"),
            thread:get("seconds"), thread:get("aged"), thread:get("made")))
    end
end
