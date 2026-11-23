-- A GET of a new URL with every request, for workload `new` (kit 1938b): /home?t=<thread>&n=<k>,
-- with k counting 1, 2, ... in each of wrk's threads, so no URL is asked for twice in a turn
-- (t=0 is left for the answer check). wrk calls request() once on its first thread to check the
-- script and does not send that request, so thread 1's first URL sent is n=2. done() prints the
-- requests and every error count as get.lua does, then each thread's last k (`LAST <t> <k>`),
-- from which run-pair.sh asks for the turn's n=2 and late URLs again to show they were kept.
local threads = {}

setup = function(thread)
    table.insert(threads, thread)
    thread:set("id", #threads)
    thread:set("n", 0)
end

request = function()
    n = n + 1
    return wrk.format("GET", "/home?t=" .. id .. "&n=" .. n)
end

done = function(summary, latency, requests)
    io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
        summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
    for _, thread in ipairs(threads) do
        io.write(string.format("LAST %d %d\n", thread:get("id"), thread:get("n")))
    end
end