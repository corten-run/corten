$ErrorActionPreference = 'Stop'
foreach ($round in 1..3) {
    foreach ($kind in @('page', 'events')) {
        foreach ($protocol in @('h1', 'h2')) {
            foreach ($count in @(200, 1200)) {
                $name = "$kind-$protocol-$round-$count"
                docker exec -d -e HOST=0.0.0.0 -e PORT=8080 corten-http2-measure sh work/http2/server.sh $name
                if ($LASTEXITCODE) { throw 'server launch failed' }
                Start-Sleep -Seconds 3
                node work/http2/load.mjs $protocol $count $kind
                if ($LASTEXITCODE) { throw "load failed: $name" }
                docker exec corten-http2-measure sh -c 'kill -TERM "$(cat /tmp/http2-server.pid)"; while kill -0 "$(cat /tmp/http2-server.pid)" 2>/dev/null; do sleep 0.1; done'
                if ($LASTEXITCODE) { throw "shutdown failed: $name" }
            }
        }
    }
}
