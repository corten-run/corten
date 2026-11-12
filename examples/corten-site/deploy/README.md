# Deploying the site

The site is one binary behind nginx on one small machine, and the page says so itself: where the
operating system counts them, it prints the machine's CPUs and memory and streams, each second,
the memory the server holds and how much of the machine's CPU and memory is in use by everything
on it (`src/works.rs`). A claim about its hosting is therefore the server's own reading, a reader
sees what the machine is under as they read, and `CORTEN_SITE_MACHINE` only adds what the system
cannot know, such as the size's name and price. Held to a limit by its own control group (a
container's `--memory` or `--cpus`, a unit's `MemoryMax=` or `CPUQuota=`), the server counts
what is in use of that limit instead, and each gauge says which it is.

| File | What it is |
|---|---|
| `provision.sh` | sets up a fresh Ubuntu 24.04 machine, once |
| `corten-site.service` | the systemd service: the binary as a user that owns nothing |
| `nginx.conf` | TLS and HTTP/2 in front, as [the deploy guide](../../../docs/guide/deploy.md) lists, a limit on the live streams one reader may hold, and the streams asked for as zstd or uncompressed |
| `release.sh` | what a deploy runs on the machine: check an upload, switch to a release, and prune old ones |
| `hold.mjs` | measures what the site holds: memory idle and with streams open, uncompressed or as a browser asks for them, and pages a second meanwhile, with the CPU and memory the server says are in use |
| [`site.yml`](../../../.github/workflows/site.yml) | the workflow that builds and ships each change on `main` |

No container runs on the machine. The workflow builds on Ubuntu 24.04, the same release the
machine runs, so the binary finds the C library it was linked against.

## Once

1. Create the machine. On DigitalOcean the smallest droplet is `s-1vcpu-512mb-10gb`:

   ```sh
   doctl compute droplet create corten-site --image ubuntu-24-04-x64 --size s-1vcpu-512mb-10gb --region sfo3 --ssh-keys <your key id>
   ```

2. Point the site's DNS name at its address, and wait until it resolves: the certificate is
   issued over port 80 at that name.
3. Make a key for deploys, and set the machine up with its public half:

   ```sh
   ssh-keygen -t ed25519 -N "" -C corten-site-deploy -f site-deploy
   scp -r examples/corten-site/deploy site-deploy.pub root@<address>:
   ssh root@<address>
   sh deploy/provision.sh <domain> <email> site-deploy.pub '<what the machine is>'
   ```

   The last line runs on the machine. Its last argument is optional: what the page adds after
   the machine's own count, for example the droplet's size and what it costs a month. Single
   quotes keep the shell from reading a price's `$`; the text itself takes no quotes or
   backslashes. Run again without it, the script keeps what it was given before, so the text can
   be changed but not removed that way; the page shows a change after the service next starts
   (`systemctl restart corten-site`, or the next deploy).
4. Make the `site` environment, which only `main` may deploy to, and give it the key. A
   repository secret could be read by a workflow on any pushed branch; an environment's is
   handed only to a job the environment's rule lets in.

   ```sh
   gh api -X PUT repos/{owner}/{repo}/environments/site --input - <<'EOF'
   {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
   EOF
   gh api -X POST repos/{owner}/{repo}/environments/site/deployment-branch-policies -f name=main
   gh secret set SITE_SSH_KEY --env site < site-deploy
   ssh-keyscan <address> | gh secret set SITE_KNOWN_HOSTS --env site
   ```

   Then delete `site-deploy`: the environment's secret is the only copy the deploys need.
5. Tell the repository where the machine is:

   ```sh
   gh variable set SITE_HOST --body <address>
   gh variable set SITE_DOMAIN --body <domain>
   ```

6. Run the Site workflow (`gh workflow run site.yml`). It starts the service for the first time.

Until `SITE_HOST` is set the workflow skips its job, so a fork deploys nothing. The job also
skips any ref but `main`.

`provision.sh` writes `HTTPS=1`, so the site sends `Strict-Transport-Security` for a year with
`includeSubDomains`. On an apex name that pins every subdomain to HTTPS in a browser that has
visited; serve the site from a name whose subdomains are all HTTPS, or from a subdomain of its own.

## Every change

A push to `main` that touches the site, the crates or the lockfile runs the workflow. It runs
the site's tests, builds the release with the commit's name in it and copies it to a directory
of its own, `/opt/corten-site/releases/<commit>-<run>-<attempt>`, where the machine checks it
against the build's SHA-256. Nothing the site is served from has changed up to there. Then it
points `/opt/corten-site/current` at the release and restarts the service, and asks for the
page, which names its commit, for the same as JSON, and for a reading from the live stream. If
the machine does not take the release, or the site does not answer all three as this commit
within 20 tries, the workflow points `current` back at the release before, restarts, says
whether that one answers as its own commit, and fails. The newest three releases are kept, and the one served
always.

Three cases leave a release served that was not checked. The first deploy has no release before
it to go back to, so one that fails stays as it is. A put-back that does not succeed in three
tries can leave the new release served; the run says where `current` points, if the machine
answers, and fails. And a run cancelled by hand, or ended by the job's 45 minutes, after the
switch and before the checks or the put-back are done leaves the new release served: run the
workflow again. The release put back is whatever was served before, checked or not, so after
any of the three, look at the site before trusting a later put-back. A machine that stops
answering is given up on within 20 seconds and counts as a failure, so the put-back runs over a
new connection.

A restart ends each open page's live stream. The browser asks for it again after a few seconds
and is sent the new process's readings, whose counts start over, when the service is up by
then, as a restart of one binary normally is. If that request arrives while the service is still down, nginx answers
502, and a browser stops asking after an answer that is not the stream: that page's readings stay
as they were until it is loaded again. The same holds for a stream the limit refused (429). Any
other request that arrives while the service is down gets nginx's 502.

## What it holds

Measured at `ff2fca828` with `hold.mjs` as it is at that commit, against the site's image in a
container held to 1 CPU and 512 MB on a workstation. `hold.mjs` ran in a second container that
shares the first one's network, so the load reached the app over loopback, with no proxy and no
TLS, and did not count against its CPU. For each run, with 1000 and then 3000 streams, held as
they are and then asked for as `zstd` and as `gzip` (a fourth argument):

```sh
docker run -d --name site --cpus 1 --memory 512m -e PORT=18488 corten-site
docker run --rm --network container:site \
  -v "$PWD/examples/corten-site/deploy/hold.mjs:/hold.mjs:ro" \
  node:24-slim node /hold.mjs http://localhost:18488 1000 10
docker rm -f site
```

Each stream is an open file. Docker Desktop, where this ran, gives a container far more than
3,000; where a container gets 1,024, add `--ulimit nofile=16384` to the first line, which is
what the service file sets on the machine.

| | Memory the server holds | Pages a second meanwhile |
|---|---|---|
| Idle | 5.3 to 5.6 MiB | |
| 1,000 live streams open, sent as they are | 18.7 to 19.4 MiB | 536 and 427 |
| 3,000 live streams open, sent as they are | 44.9 to 46.2 MiB | 327 and 456 |
| 1,000 asked for as zstd, 546 of them compressed | 87.8 to 88.7 MiB | 685 and 526 |
| 3,000 asked for as zstd, 546 of them compressed | 114.0 to 115.1 MiB | 283 and 540 |
| 1,000 asked for as gzip, 728 of them compressed | 210.2 to 210.9 MiB | 473 and 577 |
| 3,000 asked for as gzip, 728 of them compressed | 236.2 to 237.1 MiB | 611 and 445 |

Two runs of each, with 10 seconds of page loads in a run. Every stream was sent its reading each
second, and each page is about 147,400 bytes before compression (its size moves by a few
bytes with the digits in its readings). A memory range is from the
reading with the streams open to the one after the page loads, over both runs; idle is over all
twelve. The streams are held 10 seconds before the first reading where they are sent as they
are, and 90 where they are compressed: a coder's memory is held as its window fills, and a zstd
stream's window is 64 KiB, which this site's reading of about 1,500 bytes a second fills in
about 43 seconds. Held for eight minutes instead (one run each, at `7f65d026d`), 1,000 streams
asked for as zstd held 56.0 MiB after 5 seconds, 76.2 after 30 and 86.9 from 60 on, and as gzip
168.4 MiB after 5 seconds and 210.2 from 30 on. A site whose readings are smaller fills the
window more slowly, and needs a longer hold than `hold.mjs` makes.

The pages a second moved with what else the workstation was doing, so the rows cannot be
compared with each other for speed. None of these is the droplet's number. A shared vCPU is not
a workstation's core, and nginx and TLS take their part of it: run `hold.mjs` on the machine
itself, against `http://127.0.0.1:3000`, before saying what it serves. Run there, `hold.mjs` is
itself part of what the machine's CPU reading counts; run as above, the CPU and memory it prints
as in use are the container's, and `hold.mjs` is in neither.

A compressed stream holds its coder for as long as it is open. The app compresses streams up to
a budget of its own (`crates/corten/src/compress.rs`) and sends the rest as they are, which is
why 546 or 728 of them were compressed however many were open: the rows above are what the
streams hold at most, about 69 MiB more as zstd and about 191 MiB more as gzip than the same
streams sent as they are. That is the memory the server holds resident, about 130 KiB for each
zstd stream and 270 KiB for each gzip one, where the budget reserves the 480 KiB and 360 KiB a
coder may allocate. A
browser asks for its stream compressed, so without a proxy in front the gzip rows are what
readers whose browsers take no zstd would cost. `nginx.conf` therefore asks the app for a
stream as zstd where the browser lists it with no q-value, and as it is otherwise, which keeps the
machine to the zstd rows. It keeps zstd because of what a stream then sends: a reading is 1,513
bytes as it is, and 16 bytes in a zstd stream once it is under way (41 in a gzip one), by
reading one stream of each kind for eight seconds and taking the mean size of the pieces after
the first two (a script that is not in the repository; `hold.mjs` counts readings, not bytes).

What the two gauges cost, measured at `7f65d026d` against `4291a1545`, the commit before them,
in the same container: a reading went from 733 bytes to 1,539 as it is, and stayed at 16 to 20
bytes in a zstd stream; the page went from 147,854 bytes to about 149,000 before compression
(25,491 to 25,836 as zstd); and the server's own time for a page (`Server-Timing`, the median of
500 pages asked for one at a time, three times over, each image twice in turn) was 384 to 415 µs
before and 391 to 427 µs after, which these runs cannot tell apart. The page's prose has been
cut since: at `ff2fca828` the page is 147,328 bytes (25,229 as zstd) and a reading 1,513. Each
tile of the wall then became a keyed ref, 13 bytes more a tile: at `783941a55` the page is
162,531 bytes (25,565 as zstd).

## What has and has not been checked

`nginx.conf` was run in an Ubuntu 24.04 container in front of the site's image, with a
self-signed certificate: the site's smoke test passes through it in Chromium and Firefox (WebKit
under Playwright would not connect to the self-signed certificate; it passes against the app
itself), a revalidation is answered 304, the live stream arrives as it is written, a request for
another host is refused, and of 70 streams opened from one address 64 are served and 6 answered
429 while 20 of 20 pages asked for from that address are served. With the limit for one reader
lifted, of 3,600 streams 3,584 are served and 16 answered 429. What the reader map makes of an
address was asked of the same nginx for IPv4 and IPv6 addresses as nginx writes them, folded at
each group and not; the limits themselves were only exercised over IPv4. Asked through it for a
stream, the app compressed it as zstd for `gzip, deflate, br, zstd`, `zstd`, `br,zstd,gzip` and
`zstd , gzip`, and sent it as it is for `gzip, deflate, br`, `gzip`, `zstd;q=0, gzip`,
`zstd ;q=0, gzip`, `gzip, zstd ; q=0.5`, `gzip, x-zstd` and no `Accept-Encoding`, while the page
came back as zstd, Brotli or gzip as each asked. A browser that gives zstd a q-value, even
`q=1`, is sent its stream as it is: the map reads no q-values, and errs to the stream that
holds less. The service file was
checked by `systemd-analyze verify` (systemd 255).

What the server says is in use was checked in containers only: one with no limit, where it
reads the whole host's counts as it will on the machine, in the three browsers, and one held to
1 CPU and 512 MB, where it reads its control group's, in Chromium and through this nginx. In a
container the server's group is the root of the groups it sees, so those runs read
`/sys/fs/cgroup` itself; that a group further down is the one read (a systemd unit's, were the
service file given `MemoryMax=` or `CPUQuota=`) is held by a test that lays a group's files out
in a directory, and has not been run under systemd. A limit set on a group above the server's
own, or by the first version of control groups, is not looked for: the gauges are then the
machine's, and read low with the server at that limit. Of such a limit the page says only what
the standard library counts: where that is fewer CPUs than the machine has, that the server is
held to them (a quota's whole CPUs, rounded down and never fewer than one), and no limit of
memory. It has not run under the service file's
sandbox on a real machine: if the two gauges are missing there, the unit is keeping the server
from `/proc/stat` or `/proc/meminfo`.

The workflow's ship step was rehearsed against a container running sshd, with the `deploy` user
made by `provision.sh`'s own lines and a stand-in for `systemctl`: a first deploy, a second of
the same commit, a deploy that does not come up as its commit and one whose restart the machine
refuses (each put back, and the release before answers as itself), a put-back the machine
refuses once and then takes, one it refuses three times (the run says where `current` points),
an upload that is not the binary that was built (removed, and nothing served from it), and
pruning with four older releases and an empty directory present. The key was refused a terminal, a forwarded port and any other `sudo`
command. A machine that stops answering was rehearsed for the connection alone, by freezing the
container: with the workflow's options as of `d916a1b61`, `ssh` gave up 17 seconds after the
freeze mid-session, and a new connection after 10 (one run). The ship step was not run against a
machine that freezes.

The rest of `provision.sh` (packages, the firewall, the certificate), the service under a real
systemd and the workflow on GitHub have not been run from this repository yet: the first deploy
is their test.
