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
| `provision.sh` | sets up a fresh Ubuntu 24.04 machine, and leaves what is in place when run again |
| `corten-site.service` | the systemd service: the binary as a user that owns nothing |
| `nginx.conf` | TLS and HTTP/2 in front, as [the deploy guide](../../../docs/guide/deploy.md) lists, limits on what one reader may ask for and on the live streams it may hold ([below](#what-one-address-can-do)), the streams asked for as zstd or uncompressed, and other names sent on to the site's |
| `release.sh` | what a deploy runs on the machine: check an upload, switch to a release, and prune old ones |
| `hold.mjs` | measures what the site holds: memory idle and with streams open, uncompressed or as a browser asks for them, and pages a second meanwhile, with the CPU and memory the server says are in use |
| [`site.yml`](../../../.github/workflows/site.yml) | the workflow that builds and ships each change on `main` |
| `infra/` | the machine, its address and its DNS as OpenTofu configuration, with what a new machine runs as it starts (`boot.sh`, `corten-site-boot.service`) and what gives the repository its keys (`bootstrap.sh`) |
| [`site-machine.yml`](../../../.github/workflows/site-machine.yml) | the workflow that checks `infra/` and applies it on `main` |

No container runs on the machine. The workflow builds on Ubuntu 24.04, the same release the
machine runs, so the binary finds the C library it was linked against.

## Once

There are two ways to the first deploy. On DigitalOcean the machine is made from `infra/`, and
nobody signs in to it. Anywhere else, the same scripts are run by hand.

### From `infra/`, on DigitalOcean

`infra/` is OpenTofu configuration for what the site runs on: one droplet (the smallest,
`s-1vcpu-512mb-10gb`, with Ubuntu 24.04), an address that stays when the droplet is replaced, a
firewall, and the DNS zone with the name's record. The `Site machine` workflow checks it on a
pull request and applies it on `main`, keeping its state in a Spaces bucket. A droplet made this
way is handed `provision.sh`, `nginx.conf` and the service file as it starts (cloud-init), and
runs them itself: the first one once the site's name reaches it, and one that replaces another
with that one's certificate and release, before the address moves to it.

1. In DigitalOcean, make an API token and a Spaces access key. The token makes and removes
   droplets, reserved addresses, firewalls, tags, and domains with their records; one with
   full access is the simple choice. A Spaces key with full access lets the workflow make the
   bucket on its first run and keep each version of the state in it. A key that may not make
   a bucket ends that run at its first step (`AccessDenied` on `CreateBucket`, as the first
   run for corten.run did). A key limited to one bucket made beforehand has not been tried:
   the workflow sets versioning on the bucket in every run.
2. From a clone of the repository, with `gh` signed in as someone who administers it:

   ```sh
   sh examples/corten-site/deploy/infra/bootstrap.sh <domain> <email> <state bucket> https://<region>.digitaloceanspaces.com
   ```

   It makes the environments `site` and `site-machine`, which only `main` may use; makes the
   deploy key, the machine's SSH host key and the handover key, and stores each half with the
   workflow that uses it; and sets the variables both workflows read. A fifth argument,
   `refuse-mail`, adds records that say the zone sends no mail (`v=spf1 -all`, and DMARC's
   `p=reject`): only for a zone that has none. Run again, it keeps the keys, and makes the
   handover key for a repository set up before there was one.
3. Type the three secrets that are yours alone, each at `gh`'s prompt:

   ```sh
   gh secret set DIGITALOCEAN_TOKEN --env site-machine
   gh secret set SPACES_ACCESS_KEY_ID --env site-machine
   gh secret set SPACES_SECRET_ACCESS_KEY --env site-machine
   ```

4. Run the workflow (`gh workflow run site-machine.yml`). It makes everything in `infra/`, then
   waits up to half an hour for the machine to answer and ends with a warning when it does not,
   as it will not while the name points elsewhere. A zone of the site's name already in the
   DigitalOcean account makes this run fail. Removing it there removes its records, and its
   answers at once if the registrar already names DigitalOcean's servers: add its records to
   `infra/main.tf` first, or leave the zone where it is with `SITE_DNS_ELSEWHERE`.
5. At the name's registrar, name `ns1.digitalocean.com`, `ns2.digitalocean.com` and
   `ns3.digitalocean.com` as the zone's name servers. Where the registrar signs the zone
   (DNSSEC), turn that off there first and wait until the zone's `DS` record is gone:
   DigitalOcean's servers do not sign their answers, and a resolver that checks refuses them
   while the record is there (`SERVFAIL`, as corten.run answered until its record was gone).
   Records the zone had elsewhere do not come along: add each to `infra/main.tf` first. The
   machine waits for the name to reach it, however long that takes, then asks for its
   certificate and finishes setting itself up.
6. When `https://<domain>/` answers (502, with no release yet), turn deploys on and ship:

   ```sh
   gh variable set SITE_HOST --body <domain>
   gh workflow run site.yml
   ```

From then on a change on `main` under `infra/`, or to `provision.sh`, `nginx.conf` or the service
file, is applied by the workflow. The Site workflow does not run for a change to those files
and this guide alone. A merge that also changes the site starts both, and that Site run may
ship to the machine being replaced or fail against the new one while it sets itself up: the
run the `Site machine` workflow starts afterwards ships whatever became of the first (where
the first reached the new machine, as on `cd3f67f43`, the second ships the same commit again
and the service restarts once more). A droplet is never changed in place. A change to
anything it is handed, a comment in one of those files included, makes a new droplet, and the
address moves to it once it answers as the site; the old one is removed after that. A droplet
that cannot be made, or that does not come to serve, leaves the old one serving. After every
apply the workflow asks the machine at the address for the site, and starts the Site workflow
when a machine it made answers or the one there answers 502, as nginx does with no release
behind it and also while the service is down.

A new droplet serves before the address moves because it is handed what the old one serves
with. Every droplet lets one key, the handover key, run one command as root
(`infra/handover.sh`), which gives certbot's directory and the release being served, or takes
them on a machine that is not set up yet. The key signs in as a user of its own, `handover`,
which may do nothing else, and not as root: a droplet made with no key of the account is
sent a password for root, and where that password must be changed first, sshd lets no key
sign in as root either (seen in a container; not looked at on a droplet). The key's private
half is the `Site machine` workflow's alone (`SITE_HANDOVER_KEY`), and is not among what a
droplet is handed. Between
making the new droplet and moving the address, the apply runs `infra/relay.sh` on the runner:
it asks the machine at the site's name to give and the new one, at its own address, to take,
one into the other and never to a file, and then asks the new one for the page at the site's
name until it answers, with the certificate checked. The new droplet sets itself up with the
names the certificate holds, so it asks Let's Encrypt for nothing, and serves the same
release. Then the address moves, and the Site workflow the apply starts ships `main` to it.
The relay gives the new droplet ten minutes to take the key and twenty-five to serve, which
is one new try of a step that failed on it; when either runs out the apply fails with the
address where it was, the new droplet is left as it is, and the next run
(`gh workflow run site-machine.yml`) asks it again, and ships `main` to it once the address
is there. A droplet that cannot set itself up from what it was handed, however often it is
asked, is replaced by one that is handed nothing
(`gh workflow run site-machine.yml -f without_handover=true`, which makes a new one): the address
moves first, as below. What the address's own move costs is in each run's log: the site is
asked once a second while the apply runs, and the run says how many of those went
unanswered.

The address moves first, and the site is away until the new droplet has a certificate and a
release of its own, where nothing can be handed over: there is no handover key, the droplet
serving was made before there was one or with another, or the site does not answer when the
apply reaches that step (it is asked three times). The run says which, and warns where a
droplet that serves would not hand over. A droplet that serves and could not be asked over
SSH at all is not among these: the apply fails with the address where it was, so whoever
keeps its sshd busy does not take the site away. A repository set up before there was a handover
gets its key from a second run of `bootstrap.sh`, and that is best done before the change
that brings the handover is applied: the droplet made with the key is then the one that
change makes anyway. That is also every replacement made before
there was a handover, and that time is a machine's to install its packages and get a
certificate, and then a whole run of the Site workflow, which waits for a runner and tests
and builds before it ships. For the first machine made for
corten.run (one run, on `a7bbe4cc9`, with the name already at DigitalOcean's servers) the
machine answered under its certificate 1 min 42 s after the apply ended, and the Site run
started then had shipped and checked the release 1 min 53 s after that, 4 s of it waiting for
a runner. For the first replacement (one run, on `cd3f67f43`) the machine answered 1 min 22 s
after the apply ended, and the Site run started then was answered by its release 4 min 6 s
after that, 6 min 7 s after the address began to move: it waited 14 s behind another Site run
and 2 min 38 s for a runner, and was answered 1 min 14 s after it had one. The site was down
for about two of those six minutes, and that by chance. The merge had changed the site too,
so a Site run of its own had started; it waited 2 min 54 s for a runner, finished building 3 s
before the workflow first saw the machine answer, and was answered by its release 2 min 7 s
after the address began to move and 1 min 51 s after it had moved. With the 4 s wait of the
first machine's run it would by reckoning have shipped to the old machine before the move.
For the replacement on `00d1a09c8` (one run) the machine answered 2 min 2 s after the apply
ended, and the Site run started then was answered by its release 1 min 25 s after that. So
without a handover reckon on what is left of the apply after the move (39 s on `cd3f67f43`,
from its beginning), the machine's minute and a half to two and a Site run, of which the
wait for a runner is the part that moves. The old machine and its certificate are gone by
then, and Let's Encrypt issues the same names five certificates a week: a sixth such
replacement inside a week leaves the site down until its limit allows another (with names
that redirect, a machine asks for two, one for the site's name and one for all of them, and
each set of names has its own five). A machine that is handed a certificate asks for none,
unless the names given are no longer the ones it holds, and then for one, once the address
is there. When an apply fails, run the workflow again (`gh workflow run site-machine.yml`):
what it made is in the state, and the run ships the site to a machine that answers 502. With
deploys on, a run fails when the machine does not answer. To make a new machine where
nothing it is made from has changed, run the workflow with its input `replace`
(`gh workflow run site-machine.yml -f replace=true`).
If a second run fails the same way, see in DigitalOcean's control panel whether the address is
on the droplet: an apply does not notice an address that is on none, and puts it back only
when it moves it.

| Where | Name | What it is |
|---|---|---|
| environment `site` | `SITE_SSH_KEY`, `SITE_KNOWN_HOSTS` (secrets) | the deploy key, and the machine's host key under the site's name |
| environment `site-machine` | `DIGITALOCEAN_TOKEN`, `SPACES_ACCESS_KEY_ID`, `SPACES_SECRET_ACCESS_KEY` (secrets) | what makes the machine and keeps the state |
| environment `site-machine` | `SITE_HOST_KEY`, `SITE_EMAIL` (secrets), `SITE_DEPLOY_KEY`, `SITE_HOST_KEY_PUBLIC`, `SITE_HANDOVER_KEY_PUBLIC` (variables) | what a new machine is handed |
| environment `site-machine` | `SITE_HANDOVER_KEY` (secret) | the key one machine's certificate and release are carried to the next with |
| repository variables | `SITE_DOMAIN`, `SITE_STATE_BUCKET`, `SITE_STATE_ENDPOINT`, `SITE_REFUSES_MAIL` | set by `bootstrap.sh` |
| repository variables | `SITE_HOST` | set last, by hand: the Site workflow ships once it is |
| repository variables, optional | `SITE_MACHINE`, `SITE_ADMIN_KEYS`, `SITE_ZONE`, `SITE_DNS_ELSEWHERE`, `SITE_REDIRECTS` | below |

`SITE_MACHINE` is what the page adds after the machine's own count of itself (without it, the
droplet's size and region). `SITE_ADMIN_KEYS` is a JSON list of the fingerprints of SSH keys in
the DigitalOcean account that may sign in as root; with none, root is reached through the
control panel's console alone, with the password DigitalOcean emails the account for each
droplet made without a key (its practice, not checked here), and no password signs in over SSH
either way. `SITE_ZONE` names
the zone where it is not the site's name itself (`example.com` for `www.example.com`), and
`SITE_DNS_ELSEWHERE` set to `true` leaves the zone where it is: point an A record at the address
the workflow's apply prints. Changing `SITE_MACHINE` or `SITE_ADMIN_KEYS` replaces the droplet
on the next apply.

`SITE_REDIRECTS` is a JSON list of other names in the zone that send their visitors to the
site's, such as `["www.example.com"]` for a site at `example.com`. Each gets a record at the
same address and a place on the site's certificate, and nginx answers it on both ports with a
redirect (308) to the same path at the site's name; the app never sees it. With the zone
elsewhere the records are yours to make, before the variable is set. A machine that is
handed a certificate serves the names that certificate holds, and takes on the names given
once the address is there: where they are the same it asks for no certificate, and where
the list has changed, for one. A machine that is handed nothing serves the
site under its own name first, with a certificate for that name alone, and then waits for
each of the other names to reach it and asks for one certificate that holds them all: two
certificates for such a machine, and a name that is late, or that Let's Encrypt refuses, holds
back only itself. The machine says which name it waits for, or why a certificate was refused
(`journalctl -u corten-site-boot`), and tries a refused one again each quarter of an hour.
Taking the names on runs `provision.sh` a second time, which writes the deploy key's file,
the deploy's `sudo` rule and the service's environment file again: a deploy that reaches the
machine in the instant of one of those writes can fail, and is run again. That has not been
seen. Where the names are there already, the second run is over well before the Site run the
workflow starts has built its release; a Site run the merge started itself can have built
its own by then, as on `cd3f67f43`, where it shipped within half a minute of the machine
taking `www` on, and passed. After an apply the workflow asks the machine for each name, for
twenty minutes in all where it made the machine, and fails where one does not send its
visitors to the site. Twenty minutes is by reckoning a little more than one new try takes,
not a time that was waited out: a run can end red for a name the machine takes on minutes
later, and the machine goes on trying either way. Changing the list replaces the droplet on
the next apply.

The state holds no secret: of what a droplet is handed the provider keeps a hash. The bucket
keeps each version of the state, and nothing locks it but the workflow running one apply at a
time, so do not run `tofu apply` from a second place while it runs. The host key is the same on
every droplet made here, which is what lets the Site workflow know a new one as the host it
trusts. What a droplet is handed, the host key and the email among it, can be read on it from
the metadata address by any process there. The site's service cannot reach that address or any
other but the machine's own (`IPAddressDeny=` in the service file). nginx's workers and whoever
signs in as `deploy` can: the holder of the deploy key can read the host key, so the two keys
are kept apart on GitHub and not on the machine.

The handover key is not among what a droplet is handed: a droplet has its public half, and
the private half is a secret of the `site-machine` environment, given to the apply's step
alone. Its holder can run one command as root on a droplet, and so read certbot's directory
there, the certificate's private key and the Let's Encrypt account's among it, and the
release. On a droplet that is not set up yet it can also put those in place, and that makes
it root there: certbot's directory holds the hooks certbot runs as root when it renews, and
the release is what the service runs. The same environment holds the DigitalOcean token,
whose holder can read a droplet's disk, and make one, without it. The release is put in
place by the `deploy` user, whose directory it goes into, so what a deploy left in a release
gains nothing by being carried; and a release is carried only under a name of letters,
digits, `.`, `_` and `-` that starts with a letter or a digit and is not `etc`, since the
deploy user names it and root's tar reads the name. A replacement fails, with the address
where it was, while the release served has another. The deploy key cannot run the command,
and nothing on the
machine holds the private half. A new handover key (the secret and the variable removed, and
`bootstrap.sh` run again) replaces the droplet on the next apply, and the droplet serving
then does not know it: that one replacement moves the address first.

### By hand, on any machine

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
   (`systemctl restart corten-site`, or the next deploy). A fifth argument is the other names
   that send their visitors to the site's, with spaces between them (`'www.<domain>'`): point
   each at the machine first, as in step 2. It is given on every run, and the certificate
   follows it: a run whose names are not the ones the certificate holds asks for a
   certificate that holds the site's name and those given, so a run without a name stops
   redirecting it and takes it off the certificate, and its record can then go.
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
162,531 bytes (25,565 as zstd). Each tile's reading, each seam and each header then moved to a
ref value (`data-ref-value='817'` in place of `data-key="817"`, 6 bytes more a tile), which the
page's script reads with a `JSON.parse` of each: at `d1cb28f91` the page is about 161,500 bytes
(25,532 as zstd, 27,049 as Brotli, 30,974 as gzip) and with that change merged onto it about
168,150 (25,371, 26,819 and 30,836), the median of five pages in the same container, its readout's
digits moving the size by a few dozen bytes. It is larger as it is and smaller compressed.

## What one address can do

One address asking as fast as it can is slowed, so that it leaves the machine to the others.
A reader is an IPv4 address or an IPv6 network of 64 bits, as for the streams.

| Of one reader | The most | Over it | Set in |
|---|---|---|---|
| requests | 100 at once, and 20 a second after | 429 | `nginx.conf` (`limit_req`) |
| answers on their way, streams apart | 100 | 429 | `nginx.conf` (`limit_conn`) |
| live streams | 64, and 3,584 for all readers | 429 | `nginx.conf` (`limit_conn`) |
| requests on one connection | 100 | the connection ends, and a browser opens another | `nginx.conf` (`keepalive_requests`) |
| connections held | 256 | the next is reset | `provision.sh` (the firewall) |
| connections opened | 19 in any one second | the next is let in when its sender tries again, a second later at the soonest | `provision.sh` (the firewall) |

A first visit asks for 14 things, 13 or 14 of them in one second, and twenty reloads one after
another for 261, 26 or 27 in the busiest second (Chromium; 38 in one of eight runs): all
were answered through these limits, the twenty reloads in 16.0 to 16.9 seconds against 15.3
to 31.8 without them (four runs each, on a machine busy with other work). Firefox asked for
172 to 187 in its twenty reloads, 17 to 25 in the busiest second and 56 in one run, and
every one that reached nginx was answered, in 19 to 31 seconds through the limits and 14 to
30 without (four runs each). In two of the four runs through the limits Firefox gave up two
requests of its own, for the page's icons, as the next reload began, and in none of the four
without. It was not seen again: later, on a machine with no CPU to spare, four more runs
through the limits, four without and four through the limits with a connection kept for
1,000 requests were made in turn, and Firefox gave up nothing in the eleven that finished
(one through the limits timed out, as one without them had an hour before). That is 2 runs
of 7 through the limits and none of 8 without, and whether the limits have a part in it is
not settled. No limit keeps a request under it waiting: a refusal is what they add, and a
connection opened for one request in a hundred (below).

Readers behind one address share its limits: an office, a room of people, a phone
company's address for many phones. Seven can make a first visit in the same instant and one
or two a second after that, and the next is refused. Where more than 19 open a connection in
the same second the rest are left unanswered, and each is let in when its sender's TCP tries
again and fewer than 19 have been let in that second. From a sender that tries every second
(Linux from 6.5, for its first four tries), of 40 opened at once 19 connected at once, 19 a
second later and 2 a second after that, and of 100 the last 5 in the sixth second. From one
that waits twice as long each time (Linux before 6.5, set so for the run), of 40 the last 2
connected after 3 seconds, and of 100, 19 at 0, 1, 3, 7 and 15 seconds and the last 5 after
31 to 32 (two reviews' runs). All were answered; what Windows and macOS do between tries was
not run. A reader over a limit of nginx's is answered 429, with nginx's own plain page where
it was the page that was asked for; a stylesheet or script refused leaves the page without
it until it is loaded again, and a stream refused leaves the page's readings still. The
requests and the answers are two lines of `nginx.conf` (`rate=` and `burst=`, and the
`limit_conn` beside them): more there is more for a room behind one address, and as much
more for one address that means harm.

Each limit is there for something one address could otherwise do, each tried against the
configuration before it (below). Asking for the page as fast as it can: every page is
rendered and compressed on the one CPU, and the others got none. Being refused as fast as it
can: a refusal costs nginx its answer, so the requests on one connection and the connections
opened in a second are counted too, which together are 1,900 requests a second from one
address, after the 25,600 that the connections it may hold can ask at once. Asking for pages
and not reading them: nginx keeps each answer until it is read. Holding connections that ask
for nothing: nginx drops the oldest of those when it has no more, so the others are still
served, and each one held is some of its memory.

And filling the disk. A request refused for asking too fast is written to neither of nginx's
logs (so nothing on the machine says how many there were), nor is one that nginx answers
before it counts a request and so does not slow: a
redirect of another name or of port 80, a method it does not take (405), and a body that
says it is 100,000 bytes or more (413, by a `return`: nginx's own refusal of a body over its
limit is a line in each log, and 300 of those were 27 KB in one and 55 KB in the other). 300
of each wrote nothing. A challenge file that is not there is counted, and is not a line in
the error log. One refused for the answers or the streams its address holds is written to
both logs, as before: it was counted first, so there are 20 a second at the most (of 300
streams asked for at once by an address holding its 64, 108 and 112 were lines in two runs
and the rest were not). What an address under its limits asks for is still written, a line
of some 90 bytes each time, so many addresses fill the disk as they did before; logrotate
turns the logs once a day.

This is one address's limit and no more. Someone with many addresses is not slowed by it:
a few dozen addresses each at its limit ask for more pages than one CPU renders, and all
readers together hold 3,584 streams, after which a page is served and its readings stay
still. Nothing here answers a flood of packets larger than the machine's link, or one of
connections with made-up addresses, which is left to the kernel as before. The firewall's
count of connections opened remembers the last 100 addresses: with more than that opening
connections in a second it forgets each before the second is out and counts none of them, so
it is no limit while the machine is busy with many readers, where a table that refused a new
address when it was full could be filled for everyone. Those need a network in front of the
machine that takes the load, a CDN or the provider's own; this machine has none. SSH is not
limited: someone holding its connections could keep a deploy out, not the site. And nginx's
429 says nothing of when to ask again (no `Retry-After`).

Measured in containers on a workstation that other work was using: the site's image as
`f12d3daa3` builds it and nginx (Ubuntu 24.04's 1.24, one worker) with this `nginx.conf` or
the one before it and a self-signed certificate, the two held to one CPU between them, the
firewall's lines read by ufw itself in nginx's network, and each other party (the one
address, the other reader) a container with an address of its own. The one address is
h2load (nghttp2 1.59) or a script of some lines that does what its row says, and the other
reader a script that asks for the page over one HTTP/2 connection five times a second and
gives a request up after 5 seconds; the scripts are not kept here. None of it is the
droplet's number.

| One address | Before | With the limits |
|---|---|---|
| asks for the page as fast as it can for 19 seconds (`h2load -c 100 -m 100`, begun again as often as it ends) | the other reader was answered 27, 0 and 19 times in 14 seconds, half of those within 397 to 742 ms, and its other requests were reset or given up; nginx's logs grew by 1.8 to 5.6 MB | every request answered (67 to 69), half within 12 to 16 ms and nine in ten within 139 to 176 ms; the address was answered 481 to 492 times and refused 1,800 to 1,900 times a second; the logs grew by 58 KB |
| opens 19 connections a second and asks 100 times on each, for 19 seconds (`h2load -r 19 -c 361 -m 100`) | not run | every request answered (68 to 70), half within 9 to 17 ms and nine in ten within 65 to 134 ms; the address was refused 1,500 times a second |
| opens 256 connections, 15 a second, holds them, and asks 100 times on each at once | 7,000 to 7,300 of the 25,600 answered in 25 to 28 seconds and the rest failed; one or two of the other reader's requests failed in each run | all 25,600 answered in 10 to 13 seconds, 102 or 103 with the page; every one of the other reader's answered (113 to 115), nine in ten within 26 to 33 ms and the slowest, in each run, after 0.8 to 1.4 seconds |
| holds TLS connections that ask for nothing | 8,000 held, and nginx's memory went from 7 to 11 MiB to 117 to 138 MiB; every new reader was still served | 256 held and the rest reset or left waiting, nginx's memory up by 4 to 5 MiB; every new reader served |
| asks for 150 pages, 15 a second, and reads none | 150 held | 100 held, 50 answered 429 |

Three runs of each of the first three rows for each configuration, the one before an hour
ahead of the one with the limits. With no one else asking, the other reader's answers came
half within 6 to 10 ms and nine in ten within 20 to 47 ms (nine runs of 8 seconds, one before
each run with the limits; 5.5 to 9.9 ms and 16 to 39 ms before each of the others). So one
address at its limits is still felt, and no more than felt: half of another reader's pages
took some 6 ms longer and one in ten a tenth of a second longer, and none was lost. The last
two rows are two runs of each configuration and one.

With nginx's limits and not the firewall's, the other reader in the first row was answered
every time, half within 39 to 87 ms and nine in ten within 459 to 999 ms (three runs, of the
limits as they were first written): nginx was then refusing 5,200 to 9,400 requests a
second.

What the limits cost a reader under them, with the same one worker: 8,000 requests for a
small file, one after another on each of 8 connections, went at 1,764 to 1,822 a second
before and 1,513 to 1,969 with nginx's limits read and set too high to refuse; 2,000 for the
page on 4 connections at 256 to 338 a second before and 266 to 315 with. Three runs of each
in turn, which cannot be told apart. No limit keeps a request under it waiting. The requests
on one connection are the one thing a reader under the limits meets: after 100, where it was
1,000, a browser's next request opens a connection, which a first visit's 14 do not reach
and about seven reloads do. A page asked for on a connection of its own came half within 19
to 23 ms and on a kept one within 6 (three runs of 75 each, with no one else asking): about
15 ms more for the one request in a hundred that opens a connection, and on the machine the
round trips of TCP and TLS besides, which were not measured.

On the machine itself the workflow asks after every apply (`site-machine.yml`): of 300
requests at once about 100 are answered and the rest refused, of 40 connections at once to
port 80 about 21 wait a second or more, and 250 requests one after another take three
connections from each of nginx's servers. It fails where nginx refuses too few, no
connection waits, or a server keeps a connection, and the second is what says the firewall's
lines were read there: where the machine's kernel refuses them, `provision.sh` takes them
out and the machine serves without the firewall's two counts. The answers on their way and
the connections held are not asked for there: each takes hundreds of connections held open.

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
memory. Under the service file's sandbox, in the container with systemd described below, both
gauges are there, so the unit does not keep the server from `/proc/stat` or `/proc/meminfo`. On
the droplets the unit runs and the Site workflow reads a patch from the live stream; whether
both gauges are there was not looked at.

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

`provision.sh` was then run, as it is at `c49e6ba37`, in an Ubuntu 24.04 container with systemd
as its first process and none of sudo, sshd or nginx installed, and with a self-signed
certificate already where certbot would put one, since Let's Encrypt cannot reach a container.
With a certificate there the script skips the lines that ask for one, which are also the only
lines that read the email address: those lines have not been run. The rest finished: it
installed its packages, made the `deploy` user, enabled the firewall and the service, and
started nginx, which answered 308 on port 80 and 502 on 443. Run again with nginx stopped, it
started it again. The text of the workflow's ship step then shipped a release there over SSH
with the deploy key, run by bash with the three `GITHUB_` values it reads set by hand, the
certificate trusted and the name in a hosts file on the client, and sshd started by hand (a
package does not start its service in a container): the service started under systemd with the
unit's sandbox, and the page, its JSON and its live stream answered through nginx as the commit.

Linting the script before those runs found that it never read its second argument: two of its
messages each held an apostrophe, which `sh` and bash pair across the two lines. `98ddffbcc`
fixes that, shown by running those lines in Ubuntu 24.04's `sh`; the runs above skip the one
place the argument is used, so they could not show it.

`infra/` was checked without DigitalOcean, at `3211fe4f5` and, for what a review changed,
at `a8d7663eb`. `tofu validate` passes, and a plan made with no state and stand-in values
lists the six things it would make, eight with the two records that refuse mail. A plan made
from a hand-written state in which the droplet's hash differs makes the new droplet, changes
the address in place and then removes the old droplet; with the address assigned by a resource
of its own, as `3211fe4f5` had it, the same plan took the address off the old droplet before
making the new one. Plans are refused for a control character in what the machine is, a size
or region that is not a slug, an empty host key, and a name outside its zone.

What the plan hands a droplet passes `cloud-init schema`, and was given to cloud-init in a
container like the one above (with sudo and sshd, as a cloud image has): the files arrived as
they are in the repository, the host key was the one given, SSH took no password, and the boot
unit ran `boot.sh`, which finished `provision.sh`. Where the name pointed elsewhere it waited.
It went on, in one container, once the name reached the machine itself, and in another, where
the name's address answered nothing, once a stand-in for the metadata address said that address
was the machine's; while the stand-in named another address it kept waiting. At `3211fe4f5`
the ship step then shipped to such a machine, knowing it by the host key under the site's name
as `bootstrap.sh` writes it, and a restart did not set the machine up again. With the service
held to loopback, a command run under the same two settings could not reach an outside
address, and the site answered through nginx. With the package lists' lock held, a bare
`apt-get update` ended at once with status 100, and the scripts' loop went on when the lock
was let go.

The step the workflow runs after an apply was run as GitHub runs it (`bash -eo pipefail`)
against that container, with a stand-in for `gh`: it started the Site workflow for a machine
answering 502, whether or not the run had made it; with deploys off it only said so; and for an
address that answers nothing it failed after 90 seconds with deploys on and warned with them
off. `bootstrap.sh` was run in Ubuntu 24.04's `sh` against a stand-in for `gh` that records
what it is asked: it made both environments with their rule for `main`, stored the four secrets
and the variables, and on a second run kept the keys and wrote the host's line again under the
new name; after a run that had stopped between the keys' halves it made the keys again; it
stopped, writing nothing more, when the host key could not be read back; and interrupted with
the keys on disk it left nothing in its temporary directory.

The names that redirect were checked at `a8335bcd7` in Ubuntu 24.04 containers with a stand-in
for `systemctl` that starts and reloads nginx, and with certbot pointed at Pebble, Let's
Encrypt's test server, in a container beside them, so the lines that ask for a certificate ran
as they are. `provision.sh`, given one name that redirects, was issued one certificate for both
names; nginx then answered the other name with 308 to the same path and query at the site's
name on ports 80 and 443, the site's own name with 502 on 443 (no app behind it), and a name
in neither list with 308 on port 80 and 502 on 443. Run again with the same names it asked for
no certificate; with a name more, one fewer, and none, each time for one that holds the
site's name and the names given and no other, and a name no longer given was no longer
redirected on 443. It refused, before anything was installed, a URL, a name in capitals, one
that starts with a hyphen, `*`, the site's own name among the others, and a site's name with
a space in it.

`boot.sh`, with two names that redirect and one of them pointing at an address that answers
nothing, got the site's certificate and answered for the site (502), said which name it was
waiting for each 30 seconds, and when that name reached the machine was issued the
certificate for all three and redirected both. Run again as the unit would after a failure,
it asked for no certificate. With a name the machine could reach and Pebble could not
resolve, it ended in failure with the site still answering under its own certificate, and the
same on the next try. With no names it asked for one certificate and finished. The step the
workflow runs after an apply, trusting Pebble's root alone, said that each name sends its
visitors to the site; failed for a list `jq` cannot read; failed after a minute for a name
the machine does not redirect; and, told the machine was made in that run, waited and passed
when the machine took the name on half a minute in (`914ad4c7f` had the list read inside the
loop's own line, where a list that cannot be read passed). A plan with stand-in values adds
one record for each name (none with the zone elsewhere), and is refused for a name outside
the zone, the site's own name, a name given twice, and a URL. The site's smoke test was not
run again through this nginx: the server that answers the site is as it was.

At `279fdf3c0`, for what a second review changed, in the same containers: `provision.sh` took
names with spaces around and between them as the same names, took only spaces as none, and
refused a name with a dot at either end or two together and `-n`. `boot.sh`, started on a
machine that held the site's certificate and nothing else of the site (as after a first step
that ended early), set the site up without asking for a certificate, answered for it while it
waited for a late name, and then went on as above; run again after it had finished, it asked
for none. The workflow's step ended in failure 60 seconds in where the machine was not made
in that run and lacked the name, and passed 61 seconds in where it was and `provision.sh` was
started with the name 30 seconds in (it asks each 20 seconds); its twenty minutes were not
waited out. By hand a name given twice is not refused: nginx warns and ignores the second
(seen by a review), and the workflow's path refuses it. A renewal of a certificate that had
replaced the
site's (`certbot renew --dry-run`, against Pebble) passed for all three names.

On 2026-11-13 the `Site machine` workflow made the machine for corten.run from `infra/`, on
`a7bbe4cc9` (one run): `bootstrap.sh` had set the repository up on GitHub, the state went to
a Spaces bucket, the step that plans and applies made the eight things in 42 seconds, and the
droplet, handed its files by cloud-init, ran `boot.sh` and `provision.sh` and got its
certificate from Let's Encrypt, answering 502 under the site's name 1 min 42 s after the
apply. The workflow then started the Site workflow, which shipped the release and was
answered by the page, its JSON and its live stream as that commit. An earlier run had stopped
at the bucket, with a key that could not make one.

The same day the merge of `cd3f67f43` replaced that droplet, with `SITE_REDIRECTS` naming
`www.corten.run` (one run, read from the workflows' logs). The plan was two to add, one to
change and one to destroy. By tofu's own count the new droplet was made in 33 seconds, the
address moved to it in the 15 after, the record for `www` was made, and the old droplet was
gone 22 seconds after the move; by the log's times, which keep the fractions tofu drops, the
apply ended 39 seconds after the address began to move.
The step saw the machine answer 502 under the site's name 1 min 22 s after the apply ended
(it asks each 20 seconds, so the machine may have answered sooner). The Site run the merge
itself had started was shipping then and was answered by the page as that commit 6 seconds
later, and the step said `www` sends its visitors to the site on its second ask, 20 seconds
after the first answer. The Site run the workflow started shipped the same commit again and
was answered as it 4 min 6 s after the machine's first answer; the times above say where
those minutes went.

The limits on one address were checked in the containers that
[What one address can do](#what-one-address-can-do) describes and not on the droplet. The
firewall's lines were run by ufw itself, as `provision.sh` has them from `ufw allow OpenSSH`
to the `fi` that ends them: they are read into `ufw-before-input` and `ufw6-before-input`
after the rule for connections already made and ahead of the rules that open the ports, and
a second run leaves the same three in each file. The lines for IPv6 were counted against in
a second review's run: of 40 connections at once over IPv6, 21 waited, counted under their
network of 64 bits. The modules they need
(`xt_connlimit`, `xt_recent`, `xt_multiport`, `xt_comment`, and `REJECT` for both families)
are in `linux-modules-6.8.0-149-generic`, which Ubuntu 24.04's `linux-image-virtual` depends
on; which kernel the droplet runs was not looked at. With one line made to name a match that
does not exist, ufw refused the file and left the firewall dropping what nginx sends the app
(the page was answered 504). `provision.sh` takes its lines out then and starts the firewall
again: tried on a machine with no firewall, a second time on that machine, and on one whose
firewall had the lines, each ended with ufw's own rules and none of these and the page
answered 200. The rest of `provision.sh` was not run again.

A review found that the line counting connections opened, as it was first written, also
counted the ones it turned away, so an address that kept trying stayed out: of 100 opened at
once, 19 were let in at 0, 7, 12, 20 and 36 seconds and 5 not within 40 (the review's run).
As it is now, counting only those let in, 100 at once were let in 19 a second and the last 5
in the sixth second, 60 at once in four seconds and 40 in three (two runs of 40 and of 100,
one of 60), from a sender that tries again every second; a second review ran one that waits
twice as long each time, with the times given above. The first review also found the server
for the names that redirect keeping an HTTP/1.1 connection for any number of requests, its
`return` being outside a location; with it inside, 250 requests one after another took three
connections from each server, over HTTP/1.1 and HTTP/2, and from port 80 for a redirect and
for a challenge file.

The workflow's step was run from its own text (bash, curl 8.5.0, jq 1.7), with the rig's
address for the machine's, first as it then was, its 40 connections made over TLS and curl
taking the rig's certificate unchecked: with the configuration as it was first written it
failed for the name that redirects, one connection; with the one before the limits it failed
on all three counts; and for an address that answers nothing it warned and passed after 24
seconds (as first written it asked that address 300 times, one after another, and was
stopped after five minutes). Those three were not run again. A second review ran that step
with the certificate in the system's bundle, as a runner trusts a real one, on a machine
whose firewall had none of the lines, and it passed, 35 of 40 having waited: over TLS curl
reads the bundle for each connection in turn and times a connection long made as late. Run
again that way in this rig, it said 28 and 31 had waited with no lines and 30 and 34 with
them (a third review's rig: 20 and 28 with none). The 40 are now made to port 80, and the
step as it is now was run with the certificate in the bundle: 0 waited with no lines, and
it failed, and 21 with them, and it passed (two runs of each here, and two and three in the
third review's rig). With the certificate unchecked, the limits, the lines and one name that
redirects, it said 103 answered, 197 refused, 21 waited and three connections for each of
the three servers, and passed. It has not been run from one of GitHub's runners: it takes
the runner's 40 connections to leave from one address, and a runner's TCP to try again
within the 20 seconds a request is given.

The site's smoke test, in Chromium and then Firefox on a machine held to one CPU, was run six
times in turn against the limits as they are now, with two lines of `nginx.conf` changed so
that a refusal for asking too fast is written to the logs and can be counted. It passed
through the limits and the firewall's lines in 4 runs of 4: 123 answers each time (121 of
200 and 2 of 303), none refused by nginx, and no connection reset or dropped by the
firewall, by its own counters. It passed through the configuration before them in 1 run of
2, the other giving up a click in Firefox after 30 seconds. With the limits as they were
first written it had passed in 7 runs of 10, and without them in 8 of 9. Each of those
failures was in Firefox too: a click or a wait given up after 30 seconds in three of the
four, one of them with no limits, and once a check of where the window was after a click;
where nginx's answers and the firewall's counts were read after one, nothing had been
refused. A click that Playwright's Firefox acknowledges late on a loaded Windows machine is
known ([CONTRIBUTING.md](../../../CONTRIBUTING.md#checks)), and the workstation was loaded.
Four runs say that no limit acted in them, not that none ever does in this test.

The handover was rehearsed in containers and not on a droplet, at `7af97547d` and, after a
review, every case again at `7d835fe17`; the numbers here are the second time's unless they
say otherwise. Two containers of Ubuntu 24.04 with systemd as their first process, sudo and
sshd were each handed by a script what `main.tf` hands a droplet, the same host key among
it, and a third holds the site's name and sends ports 22, 80 and 443 on to one of them,
which stands in for the address. Root on each was held to a password that must be changed,
and no key was root's. The first machine held a self-signed certificate laid out as certbot
keeps one, with an account and a renewal file beside it, and a release shipped by
`release.sh`; Let's Encrypt's names led nowhere, so a machine that asked for a certificate
failed. `relay.sh` ran in a fourth container, as the apply runs it. In a whole replacement
it ended 65 seconds after the new machine was made, most of that the machine installing its
packages, and the address was moved then: of 102 requests a second apart none went
unanswered (the first time, 152 and 118 seconds, and one of 203 and none of 170, the one as
the rig's address moved, which says nothing of DigitalOcean's). The new machine had the same
certificate and key, the account and the renewal file, the release owned by `deploy` and
served under the unit's sandbox, no log from certbot, the firewall started once, and
nothing left of what it was sent; its boot unit finished once the address was there, and a
deploy to it by the deploy key was served. A file left in the first machine's release that
runs as its owner arrived as `deploy`'s without that bit, nothing under the releases was
root's, and certbot's `cli.ini`, changed on the first machine, was the package's own on the
second. On a machine that is set up the handover key was refused `take`, any other command,
a word with more after it, no word, a terminal and a forwarded port, and did not sign in as
root or as `deploy`; the `handover` user without sudo, and `deploy` through sudo, were
refused the command. Cut short at each tenth of its length and one byte from its end, what
`give` writes was refused by `take` ten times of ten, with nothing kept; the same tar
without gzip, cut between two files, was read by tar as whole both times tried (the first
time), which is why it is sent as gzip.

With no key, with a key the serving machine does not know, and with the site stopped, the
relay said so and ended well, and the address moved first; for the first it wrote a notice
and for the second a warning to the file the workflow prints. What such a machine then does
is as it was before, and was not run again. With the relay's clock run fast, a new machine
that was handed no key was given up on as not taking it, and one that had taken everything
as not serving in time: each ended in failure with an error in that file, the address
stayed, and none of 26 and of 39 requests went unanswered. Run again for the second machine
once it served, the relay handed nothing over a second time and ended well. A new machine
given no names that redirect, where the certificate held one, served with the certificate it
was handed and, once the address was there, asked for another, which in this rig fails: the
site went on answering meanwhile. That step has not been run against a server that issues.

The order the apply keeps was tried in OpenTofu 1.13.9 with `terraform_data` standing in
for the droplet and the address, wired as they are in `main.tf`: the new one made, the relay
run, the address changed, the old one removed; and where the relay failed, the address
unchanged, the new one kept, and the relay run again by the next apply (a review ran the
same, and a first apply on a state made before this, a relay failing twice, and a
replacement asked for after a failure). A plan with the provider itself and stand-in values
makes the eight things, the address's droplet known only after the apply. `bootstrap.sh`,
against the stand-in for `gh`, made the three keys for a repository with nothing, kept them
on a second run, made the handover key alone for a repository that had the other two, and
made both its halves again where one was missing. The workflow's step that plans and
applies was run from its own text with a stand-in for `tofu`: it passed the option that
replaces the machine when asked to, printed what the relay had written, said how many
requests went unanswered when the apply ended well and when it failed (6 of 6 for a name
that does not answer as the site), and left nothing asking afterwards. Its reading of a plan
says a machine was made for a first apply, a replacement, and the run after a relay that
failed, where the plan makes none and moves the address, and not for a plan that changes
neither.

A second review found that a release's name, which the deploy user chooses, reached root's
tar unchecked: it ran `give` for a release named `etc`, whose files were then merged into
certbot's directory on the machine that took them, and for names tar reads as options, one
of which removed the certificates and one of which ran a command as root. At `712be1e57`,
in the same rig, `give` refused a served release named `etc`, `--remove-files`, `-x`,
`.hidden`, one with a space in it, one inside another, and `current` pointing at certbot's
directory: each time nothing was sent, nothing was run and the certificate was still there,
and the release as a deploy names it was sent whole. A whole replacement again ended 108
seconds after the new machine was made, with none of 145 requests unanswered and the new
machine as above. Run again for that machine with its first question whether the machine
serves made to fail, the relay was refused by `take`, found that the machine served, and
ended well; with the old machine serving a release named `etc`, it ended in failure with an
error for the workflow, and the address stayed.

A third review found nothing in those changes by which the deploy key gains from a
handover, and found that `provision.sh`, as it was before the handover too, wrote as root
into directories the deploy user owns whenever it ran a second time: with links that user
had put there, a file under `/etc` became that user's (the review's run). At `0d1725e6d` it
writes there as that user. Run again on a machine that had taken over, with
`authorized_keys`, then `.ssh`, then `releases` replaced by a link into `/etc`, it failed
for the first two and passed for the third, and what the links pointed at was root's and
unchanged each time; with the links gone it passed, and a deploy to that machine was served.
The relay, for an old machine that refuses the key, moved the address first with its warning
as before; for one whose sshd was stopped while the site answered, it ended in failure with
the address where it was and none of 35 requests unanswered; and with the old machine's tar
made to end badly after sending everything, it went on, since the new machine had kept it,
and the replacement ended with none of 276 requests unanswered, 286 seconds after the
machine was made on a workstation busy with other work. `handover.test.sh` passes as it is
and fails with any of five lines of `handover.sh` changed: the names refused, gzip, the
package's `cli.ini` left out, a release required, and the bit that runs a file as its owner
dropped.

What that leaves untried is everything DigitalOcean and GitHub do in it: a droplet letting
the `handover` user in by its key (it is made as `deploy` is, whose key the Site workflow
signs in with; a droplet that does not is one that hands nothing over, or takes nothing, and
the relay says which), whether root there is held to a password, the relay from a runner,
GitHub reading the lines the workflow prints as a warning, the input that hands a machine
nothing, how long a reserved address takes to move and whether a request in flight is lost
to it, and a renewal on a machine that was handed its certificate. The rig is not in the
repository, as none of this directory's rehearsals are: CI lints these scripts, validates
`main.tf`, and runs the handover's command in a container against the names a deploy could
give a release, a handover cut short and one with no release in it
(`infra/handover.test.sh`); the rest is rehearsed again by whoever changes it. The
machine serving when this was merged was made before there was a handover, so the first
replacement after it moves the address first; the one after that is the first to be handed
anything, and its run's count is the first measure of the move.

Among what has still not run on a real machine: an apply that fails once begun or a droplet
that cannot be made, a first deploy that fails, a put-back of the release before, a machine
that freezes during a ship or never answers the workflow, a name that reaches the machine
late or is refused its certificate, a renewal, `hold.mjs`, the limits on one address beyond
what the workflow asks for after an apply, the optional variables other than
`SITE_REDIRECTS`, and the steps by hand. Which of `boot.sh`'s two ways
ended its wait on either droplet was not looked at, so whether a droplet can reach its own
reserved address from inside is still not known, nor whether the two metadata paths
(`reserved_ip/ipv4/active` and `ip_address`) answer as `boot.sh` reads them.
