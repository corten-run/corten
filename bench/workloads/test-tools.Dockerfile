ARG PLAYWRIGHT_IMAGE
FROM ${PLAYWRIGHT_IMAGE} AS playwright
FROM playwright AS build

RUN apt-get -o Acquire::Retries=5 update -qq --error-on=any \
    && apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends \
      build-essential ca-certificates curl gpg gpgv libcurl4-gnutls-dev libexpat1-dev \
      libpcre2-dev libssl-dev perl pkg-config xz-utils zlib1g-dev
WORKDIR /tmp/git-build
COPY scripts/benchmark-evidence-git.sh /tmp/verify-git.sh
RUN sh /tmp/verify-git.sh
RUN --network=none tar -xf git.tar && cd git-2.56.1 \
    && make -j2 prefix=/usr DESTDIR=/out INSTALL_STRIP=-s INSTALL_SYMLINKS=1 \
      NO_RUST=1 NO_GETTEXT=1 NO_TCLTK=1 NO_GITWEB=1 USE_LIBPCRE2=1 install

FROM playwright
COPY --from=build /out/ /
RUN --network=none set -eu; \
    test "$(command -v git)" = /usr/bin/git; \
    test "$(git --no-replace-objects --no-lazy-fetch --version)" = 'git version 2.56.1'; \
    repo=$(mktemp -d); git init -q "$repo/source"; \
    printf evidence > "$repo/source/blob"; git -C "$repo/source" add blob; \
    git -C "$repo/source" -c user.name=CI -c user.email=ci@example.invalid commit -qm fixture; \
    git -C "$repo/source" config uploadpack.allowFilter true; \
    git clone -q --no-local --no-checkout --filter=blob:none "$repo/source" "$repo/replay"; \
    git -C "$repo/replay" config protocol.file.allow always; \
    oid=$(git -C "$repo/source" rev-parse HEAD:blob); \
    if git --no-replace-objects --no-lazy-fetch -C "$repo/replay" cat-file blob "$oid" >/dev/null 2>&1; then exit 1; fi; \
    test "$(git --no-replace-objects -C "$repo/replay" cat-file blob "$oid")" = evidence; \
    test "$(git --no-replace-objects --no-lazy-fetch -C "$repo/replay" cat-file blob "$oid")" = evidence; \
    rm -rf "$repo"
