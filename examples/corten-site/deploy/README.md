# Deploying the site

The site is one binary behind nginx on one small machine, and the page says so itself: where the
operating system counts them, it prints the machine's CPUs and memory and streams the memory the
server holds (`src/works.rs`). A claim about its hosting is therefore the server's own reading,
and `CORTEN_SITE_MACHINE` only adds what the system cannot know, such as the size's name and price.

| File | What it is |
|---|---|
| `provision.sh` | sets up a fresh Ubuntu 24.04 machine, once |
| `corten-site.service` | the systemd service: the binary as a user that owns nothing |
| `nginx.conf` | TLS and HTTP/2 in front, as [the deploy guide](../../../docs/guide/deploy.md) lists, and a limit on the live streams one reader may hold |
| `release.sh` | what a deploy runs on the machine: check an upload, switch to a release, and prune old ones |
| `hold.mjs` | measures what the site holds: memory idle and with streams open, and pages a second meanwhile |
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
whether that one answers, and fails. The newest three releases are kept, and the one served
always.

A restart ends each open page's live stream. The browser asks for it again after a few seconds
and is sent the new process's readings, whose counts start over, when the service is up by
then, as a restart of one binary normally is. If that request arrives while the service is still down, nginx answers
502, and a browser stops asking after an answer that is not the stream: that page's readings stay
as they were until it is loaded again. The same holds for a stream the limit refused (429). Any
other request that arrives while the service is down gets nginx's 502.

## What it holds

Measured with `hold.mjs` against the site's image in a container held to 1 CPU and 512 MB, on a
workstation, with the load coming from inside the container's network (no proxy, no TLS):

```sh
node examples/corten-site/deploy/hold.mjs http://localhost:18488 1000 10
```

| | Memory the server holds | Pages a second meanwhile |
|---|---|---|
| Idle | 5.2 to 5.6 MiB | |
| 1,000 live streams open | 18.3 to 18.7 MiB | 481 and 525 |
| 3,000 live streams open | 44.4 to 45.5 MiB | 398 and 398 |

Two runs of each. Every stream was sent its reading each second, and each page is 147,495 bytes
before compression. The memory figures did not move between runs. The pages a second did with
what else the workstation was doing: these runs shared its eight CPUs with other builds that
kept them busy, and an earlier build of the same page measured 1,172 and 1,035 in a quieter
hour. Neither is the droplet's number. A shared vCPU is not a workstation's core, and nginx and
TLS take their part of it: run `hold.mjs` on the machine itself, against `http://127.0.0.1:3000`
with `HOSTS` allowing it, before saying what it serves.

## What has and has not been checked

`nginx.conf` was run in an Ubuntu 24.04 container in front of the site's image, with a
self-signed certificate: the site's smoke test passes through it in Chromium and Firefox (WebKit
under Playwright would not connect to the self-signed certificate; it passes against the app
itself), a revalidation is answered 304, the live stream arrives as it is written, a request for
another host is refused, and of 70 streams opened from one address 64 are served and 6 answered
429 while 20 of 20 pages asked for from that address are served. With the limit for one reader
lifted, of 3,600 streams 3,584 are served and 16 answered 429. What the reader map makes of an
address was asked of the same nginx for IPv4 and IPv6 addresses as nginx writes them, folded at
each group and not; the limits themselves were only exercised over IPv4. The service file was checked by `systemd-analyze verify`
(systemd 255).

The workflow's ship step was rehearsed against a container running sshd, with the `deploy` user
made by `provision.sh`'s own lines and a stand-in for `systemctl`: a first deploy, a second of
the same commit, a deploy that does not come up as its commit and one whose restart the machine
refuses (each put back, and the release before answers), an upload that is not the binary that
was built (removed, and nothing served from it), and pruning with four older releases and an
empty directory present. The key was refused a terminal, a forwarded port and any other `sudo`
command.

The rest of `provision.sh` (packages, the firewall, the certificate), the service under a real
systemd and the workflow on GitHub have not been run from this repository yet: the first deploy
is their test.
