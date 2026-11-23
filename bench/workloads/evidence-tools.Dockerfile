ARG PLAYWRIGHT_IMAGE
FROM ${PLAYWRIGHT_IMAGE}

# Context: only the two verified PPA packages, never a runner home or checkout.
RUN --network=none --mount=type=bind,target=/debs,ro set -eu; \
    dpkg -i /debs/git-man.deb /debs/git.deb; \
    for pkg in git git-man; do \
      test "$(dpkg-query -W -f='${Version}' "$pkg")" = "$(dpkg-deb -f "/debs/$pkg.deb" Version)"; \
    done; \
    test "$(command -v git)" = /usr/bin/git; \
    git --no-replace-objects --no-lazy-fetch --version; \
    repo=$(mktemp -d); git init -q --bare "$repo"; \
    oid=$(printf evidence | git -C "$repo" hash-object -w --stdin); \
    test "$(git --no-replace-objects --no-lazy-fetch -C "$repo" cat-file blob "$oid")" = evidence; \
    rm -rf "$repo"
