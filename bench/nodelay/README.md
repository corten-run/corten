# Nagle's algorithm and a burst of small live events

Does a streamed answer's small writes wait for a delayed acknowledgement when `TCP_NODELAY` is
not set? This measures it through nginx, the way an app with live streams is deployed
([Deploying](../../docs/guide/deploy.md#nginx)), and records why Corten's listeners set it
([design Choice 41](../../docs/design.md#choice-tcp-nodelay)).

## What a run does

1. [app](app) is a Corten app whose `GET /burst/{gap}` is a `corten::live` stream of ten small
   events (about 50 bytes on the wire each): the first at once, each later one `gap`
   microseconds after the one before (0: on the runtime's next turn, so each is a write of its
   own), each carrying when it was made after the first. Three copies run, each in its own
   container: `NODELAY` unset (Corten's own listeners, `corten::serve`), `on` and `off` (the
   same listeners wrapped in a `Listener` of the app's own that sets `TCP_NODELAY` as told).
2. nginx 1.29 ([nginx.conf](nginx.conf): the deploy guide's `upstream` with `keepalive`, one
   worker, so streams to an app reuse one connection to it) runs in a fourth container, and
   [client.mjs](client.mjs) (Node 24) in a fifth, all on one Docker network: every hop is a TCP
   connection between two network namespaces, not loopback.
3. The client opens each (app, gap) stream five times in a row, on a new connection to nginx
   each time, URL after URL, 20 rounds (after one it discards), each round starting one URL
   further on than the round before. It records when each stream was sent and ended, when the
   headers came, and when each event came.

For each stream: how late each event came after the first, less how much later the app made it
than the first. A stream is "busy" when the stream just before it went to the same app, so nginx
reused its connection a fraction of a millisecond after its last use, as under steady traffic,
and "after idle" when the stream before went to another app, so the connection sat unused while
the other apps ran (how long is in each summary as `idleMs`).

## Running it

```sh
docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay .
node bench/nodelay/run.mjs <name> [rounds=20] [repeat=5] [gaps=0,1000,10000] [--image corten-nodelay]
```

It writes `results/<name>.json` (the summary) and `results/<name>.streams.jsonl` (every stream,
not committed), prints the summary, and removes its containers and network.

The image to compare against, `corten-nodelay:before`, is the same build from a copy of the
checkout with the line `let _ = stream.set_nodelay(true);` taken out of `TcpListener`'s `accept`
in `crates/corten/src/listener.rs`; pass it with `--image corten-nodelay:before`.

The packet capture below watched a run of that image at gap 0 alone
(`node bench/nodelay/run.mjs capture 20 5 0 --image corten-nodelay:before`), started once the
`nodelay-default` container was up:

```sh
docker run --rm --network container:nodelay-default alpine:3 sh -c "apk add -q tcpdump && timeout 30 tcpdump -i eth0 -nn -tt -l 'tcp port 8080'"
```

## Results

Measured on 2026-11-11 on Docker Desktop's Linux VM (kernel 6.18.58, WSL 2) on a Windows
workstation that was also running other builds, nginx 1.29.8. Two runs of each build, alternated
(`before-a`, `after-a`, `before-b`, `after-b` in [results](results)): before is `a833b4e3`
without the line above, after is the change. Each cell gives the two runs' medians of how late
the second event came (ms), the range over both runs, and how many of their bursts had an event
more than 20 ms late, all read from the two summaries.

| Corten's own listeners, busy | gap 0 | gap 1 ms | gap 10 ms |
|---|---|---|---|
| before (Nagle on) | 44.3 and 43.3 (-0.1 to 89.0), 158 of 160 | 40.1 and 40.7 (18.6 to 58.9), 159 of 160 | 31.9 and 31.8 (-0.9 to 54.3), 156 of 160 |
| after (`TCP_NODELAY`) | -0.06 and -0.06 (-0.8 to 0.8), 0 of 160 | -0.08 and -0.11 (-13.9 to 10.1), 2 of 160 | 0.03 and -0.01 (-11.4 to 15.5), 2 of 160 |

The `on` and `off` copies, the same in both builds, gave the same picture as after and before:
`off` busy at gap 0 44.4 and 42.7 ms (before build), 45.5 and 43.6 (after); `on` -0.07 and -0.06,
-0.05 and -0.06. With the option set (Corten's listeners in the after build, and `on` in both), 11
of 1,800 bursts had an event more than 20 ms late, at most 51.8 ms, all at a gap of 1 or 10 ms,
on both copies and both builds: timer noise on a loaded host, against 40 ms or so for nearly
every busy burst without it.

After idle: of 720 such streams, the 651 whose app connection had been unused at least 150 ms
(medians per cell 270 ms to 1.3 s) had 5 with an event more than 20 ms late (22 to 35 ms), on the
`on` and `off` copies alike, so the same noise. Of the 57 that followed less than 150 ms unused,
11 were held 37 to 48 ms, all on copies without the option and all after 18 to 43 ms unused,
behaving as busy ones. So the delay is on a connection reused soon after its last stream; a
connection unused a few hundred milliseconds was not shown delayed in any configuration.

Every event the app had made by the time the acknowledgement came arrived with the second (busy,
without the option): at gap 0 all nine in each of 473 held bursts, at 1 ms all nine in 446 of
474, at 10 ms two to five, mostly three, the rest as they were made. The first event came with
the headers (median 0.1 ms after them; 30.5 ms once, on a run's first stream), since hyper
writes the head and the first event together. In the capture, 87 bursts to the default copy were
seen whole; 75 had their second data segment 40.2 to 46.5 ms after the first, each within 0.1 ms
of nginx's acknowledgement of the first: the head and first event in one segment (757 bytes),
then the other nine events and the stream's end in one (473 or 474 bytes). The delay is close to Linux's minimum
delayed-acknowledgement time (40 ms), less the gap at 10 ms. Negative numbers are timer noise: an
event made 10 ms after the first is timed by the app, its arrival by the client.

The request-path cost (callgrind, `tests::what_a_request_over_tcp_costs` in the crate) was
measured on `efbd210d` and the change; it is in
[design Choice 41](../../docs/design.md#choice-tcp-nodelay).
