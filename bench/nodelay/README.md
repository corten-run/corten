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

Build the two images from a checkout of this branch (`bench/nodelay/app` is in no other), the
second from a copy of it with the line `let _ = stream.set_nodelay(true);` taken out of
`TcpListener`'s `accept` in `crates/corten/src/listener.rs`, then run each:

```sh
docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay:after .
docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay:before .  # in the copy
node bench/nodelay/run.mjs before-a 20 5 0,1000,10000 --image corten-nodelay:before
node bench/nodelay/run.mjs after-a 20 5 0,1000,10000 --image corten-nodelay:after
```

`run.mjs <name> [rounds=20] [repeat=5] [gaps=0,1000,10000] [--image corten-nodelay]` writes
`results/<name>.json` (the summary) and `results/<name>.streams.jsonl` (every stream, not
committed), prints the summary, and removes its containers and network. Each cell of a summary
counts, besides the medians and ranges, the bursts over 20 ms (the first event more than 20 ms
after the headers, or a later one more than 20 ms late, `over20ms`), the first events more than
20 ms after the headers (`firstOver20ms`), and the held bursts (the second event more than 20 ms
late, `held`), with how many events came with the second in each (within 0.5 ms of it, the second
included, `heldEventsWithSecond`). An after-idle cell also splits its bursts at 150 ms unused
(`idleUnder150ms`, `idle150msOrMore`; a run's first stream on an app counts as under) and lists
each burst over 20 ms with how long its connection had been unused and how late it was (`over20`).

The packet capture below watched a run of the before image at gap 0 alone
(`node bench/nodelay/run.mjs capture 20 5 0 --image corten-nodelay:before`), started once the
`nodelay-default` container was up:

```sh
docker run --rm --network container:nodelay-default alpine:3 sh -c \
  "apk add -q tcpdump && timeout 30 tcpdump -i eth0 -nn -tt -l 'tcp port 8080'"
```

## Results

Measured on 2026-11-11 on Docker Desktop's Linux VM (kernel 6.18.58, WSL 2) on a Windows
workstation that was also running other builds, nginx 1.29.8. Two runs of each build, alternated
(`before-a`, `after-a`, `before-b`, `after-b` in [results](results)), 900 streams each: after
is this branch at `4ecc8841` (its Rust as at `a833b4e3`), before the same without the line above.
Every number below is read from, or
summed over, those four summaries. Each cell of the table gives the two runs' medians of how late
the second event came (`secondLateMs.median`, ms), the range over both runs, and how many of
their bursts were over 20 ms (`over20ms`).

| Corten's own listeners, busy | gap 0 | gap 1 ms | gap 10 ms |
|---|---|---|---|
| before (Nagle on) | 42.5 and 43.0 (-0.1 to 66.0), 158 of 160 | 40.9 and 40.8 (-1.2 to 64.9), 159 of 160 | 31.8 and 32.7 (-0.2 to 54.5), 157 of 160 |
| after (`TCP_NODELAY`) | -0.07 and -0.09 (-2.0 to -0.03), 0 of 160 | -0.05 and -0.04 (-7.6 to 9.6), 1 of 160 | -0.01 and -0.01 (-11.1 to 4.9), 0 of 160 |

The `on` and `off` copies, the same in both builds, gave the same picture as after and before:
`off` busy at gap 0 42.9 and 43.2 ms (before build), 44.3 and 41.9 (after); `on` -0.06 and -0.07,
-0.07 and -0.09. With the option set (Corten's listeners in the after build, and `on` in both), 6
of 1,800 streams were over 20 ms, at most 29.9 ms, and none was held: timer noise on a loaded
host, against a held second event in nearly every busy stream without it.

After idle (`idleUnder150ms`, `idle150msOrMore` and `over20` in the after-idle cells): of 720
such streams, 644 followed at least 150 ms unused, and 6 of them were over 20 ms (21.6 to
33.1 ms), 2 of those with the option set, so no more than the noise above. Of the 76 that followed
less than 150 ms unused (between other apps' blocks at gap 0, which take tens of milliseconds),
15 were over 20 ms (29.0 to 46.6 ms), all on copies without the option and all after 14.9 to
33.6 ms unused, behaving as busy ones. So the delay is on a connection reused soon after its last
stream; a connection unused a few hundred milliseconds was not shown delayed in any configuration.

Every event the app had made by the time the acknowledgement came arrived with the second, in
the held busy streams without the option (`heldEventsWithSecond`): at gap 0 all nine in each of
475, at 1 ms all nine in 462 of 471 and six to eight in the rest, at 10 ms two to five (three in
315 of 472), the rest as they were made. The first event came with the headers (median 0.1 ms
after them); it was more than 20 ms after them in 3 of 3,600 streams (21.6, 28.0 and 29.9 ms,
`firstOver20ms` and `firstAfterHeadMs.max`), since hyper writes the head and the first event
together.

The capture (observed once, before image, gap 0; the capture itself is not committed) saw 87
bursts to the default copy whole; 75 had their second data segment 40.2 to 46.5 ms after the
first, each within 0.1 ms of nginx's acknowledgement of the first: the head and first event in
one segment (757 bytes), then the other nine events and the stream's end in one (473 or 474
bytes). The delay is close to Linux's minimum delayed-acknowledgement time (40 ms), less the gap
at 10 ms. Negative numbers are timer noise: an event made 10 ms after the first is timed by the
app, its arrival by the client.

The request-path cost (callgrind, `tests::what_a_request_over_tcp_costs` in the crate) was
measured on `efbd210d` and the change; it is in
[design Choice 41](../../docs/design.md#choice-tcp-nodelay).