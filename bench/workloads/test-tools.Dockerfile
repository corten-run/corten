ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.64.1-noble
FROM ${PLAYWRIGHT_IMAGE}

# Keep the upstream stable PPA and its exact signing key, without the Launchpad
# metadata API used by add-apt-repository. Interrupted API reads blocked CI.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 60 'https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xF911AB184317630C59970973E363C90F8F1B6217' -o /tmp/corten-git-ppa.asc \
    && gpg --batch --show-keys --with-colons /tmp/corten-git-ppa.asc > /tmp/corten-git-ppa.keys \
    && test "$(awk -F: '$1 == "pub" { primary=1; next } primary && $1 == "fpr" { print $10; primary=0 }' /tmp/corten-git-ppa.keys)" = F911AB184317630C59970973E363C90F8F1B6217 \
    && install -m 0644 /tmp/corten-git-ppa.asc /etc/apt/keyrings/corten-git-ppa.asc \
    && install -m 0644 /dev/null /etc/apt/sources.list.d/corten-git-ppa.list \
    && printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/corten-git-ppa.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main' > /etc/apt/sources.list.d/corten-git-ppa.list \
    && apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends git \
    && git --no-replace-objects --no-lazy-fetch --version \
    && rm -rf /var/lib/apt/lists/* /tmp/corten-git-ppa.keys /tmp/corten-git-ppa.asc
