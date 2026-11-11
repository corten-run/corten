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
   each time, URL after URL, 20 rounds (after one it discards), reversing the order every other
   round. It records when the headers came, and when each event came.

For each stream: how late each event came after the first, less how much later the app made it
than the first. "Busy" is a stream that followed another to the same app at once, so nginx
reused its connection a few milliseconds after its last use, as under steady traffic; "after
idle" is the first of five, after the connection sat unused a few hundred milliseconds.

## Running it

```sh
docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay .
node bench/nodelay/run.mjs <name> [rounds=20] [repeat=5] [gaps=0,1000,10000] [--image corten-nodelay]
```

It writes `results/<name>.json` (the summary) and `results/<name>.streams.jsonl` (every stream,
not committed), prints the summary, and removes its containers and network.

## Results

Measured on 2026-11-11 on Docker Desktop's Linux VM (kernel 6.18.58, WSL 2) on a Windows
workstation that was also running other builds, nginx 1.29.8. Two runs of each build, alternated
(`before-a`, `after-a`, `before-b`, `after-b` in [results](results)): before is `efbd210d`,
after is the change that sets `TCP_NODELAY` in Corten's accept. Each cell pools the two runs:
the median of how late the second event came (ms), its range, and how many bursts had an event
more than 20 ms late.

| Corten's own listeners, busy | gap 0 | gap 1 ms | gap 10 ms |
|---|---|---|---|
| before (Nagle on) | 41.6 (39.2 to 53.7), 160 of 160 | 39.5 (-2.1 to 54.4), 159 of 160 | 31.3 (23.8 to 56.1), 160 of 160 |
| after (`TCP_NODELAY`) | -0.1 (-0.4 to 2.4), 0 of 160 | -0.1 (-4.1 to 14.6), 0 of 160 | 0.0 (-3.2 to 9.2), 0 of 160 |

After idle, before: 18 of 40 bursts with gap 0 had an event more than 20 ms late (at most 45.5
ms), none with gaps of 1 or 10 ms; after: none. The `on` and `off` copies, the same in both
builds, gave the same picture as after and before: `off` busy 41.7 / 42.3 ms at gap 0 (before /
after build), `on` busy -0.1 in both. Only `off` after idle at a 10 ms gap was delayed there,
20 of 40 bursts (median 14.9 and 17.2 ms).

Every event the app had made by the time the acknowledgement came arrived with the second: at
gap 0 and 1 ms all nine, at 10 ms the first three or four, the rest as they were made. The first
event came with the headers in every run (median 0.1 ms after them), since hyper writes the
head and the first event together. A capture (`tcpdump` in the app's network namespace) of a
busy burst at gap 0 shows the pattern: the head and first event in one segment, nginx's
acknowledgement 40 to 44 ms later, then the other nine events and the stream's end in one
segment. The delay is close to Linux's minimum delayed-acknowledgement time (40 ms), less the
gap at 10 ms. Negative numbers are timer noise: an event made 10 ms after the first is timed by
the app, its arrival by the client.
