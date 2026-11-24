-- The workload `after`: requests that do not wait, on connections that have set their kept timer.
-- Each of wrk's threads returns GET /wait (the page from a handler that sleeps 1 ms) from its
-- first WAITS calls of request(), whichever of its connections asks, and GET /private (the URL on
-- wrk's command line, the page with no wait) from every call after. With -t2 -c64 a thread has 32
-- connections, so WAITS = 512 is 16 requests that wait for each connection if they take turns; a
-- connection has set its timer once three of its requests have waited. Neither request has a
-- header of its own. (wrk checks a script by calling its first thread's request() once before any
-- connection is open, and sends nothing for that call.)
--
-- wrk calls request() in the thread that sends, with nothing that names the connection, so this
-- script cannot see how many of the first WAITS a connection sent; state.sh reads that from the
-- packets of whole turns before anything is counted. What done() can see, it checks: there are
-- two threads and each called request() more than WAITS times, so each reached the requests that
-- do not wait. If not, it prints no RESULT line, which fails the turn.

WAITS = 512
calls = 0

local threads = {}

setup = function(thread)
    table.insert(threads, thread)
end

init = function(args)
    wait_request = wrk.format("GET", "/wait")
    plain_request = wrk.format("GET")
end

request = function()
    calls = calls + 1
    if calls <= WAITS then return wait_request end
    return plain_request
end

done = function(summary, latency, requests)
    local ok = #threads == 2
    for i, thread in ipairs(threads) do
        local n = thread:get("calls")
        io.write(string.format("AFTER thread %d: request() called %d times, GET /wait from the first %d\n",
            i, n, math.min(n, WAITS)))
        if n <= WAITS then ok = false end
    end
    if ok then
        io.write(string.format("RESULT %d %d %d %d %d %d\n", summary.requests, summary.errors.connect,
            summary.errors.read, summary.errors.write, summary.errors.status, summary.errors.timeout))
    else
        io.write("AFTER-FAILED: not two threads, or a thread did not reach the requests that do not wait\n")
    end
end
