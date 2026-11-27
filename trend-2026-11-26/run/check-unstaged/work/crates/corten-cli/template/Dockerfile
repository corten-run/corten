# syntax=docker/dockerfile:1
FROM rust:1-trixie AS build
WORKDIR /src
# `docker build --build-arg PROFILE_FROM=train.sh .` builds the release with a profile of the app
# at work: `corten build --profile-from`, in the second RUN, runs a copy of the app in this build while
# the app's script sends it requests, and gives the release build what the copy recorded
# (https://github.com/corten-run/corten/blob/main/docs/guide/deploy.md#a-profile-in-the-image).
# The copy starts with what a build has, so not beside a database or another service. Without the
# argument this RUN does nothing and the build below is the ordinary one. The `corten` command is
# the release of the number `corten new` wrote this file with, installed into this layer: cargo's
# home here is a cache, which is no part of the layer and which other apps' builds write. A
# command without the option would build with no profile and no word, so that is refused here.
ARG PROFILE_FROM=
RUN --mount=type=cache,target=/var/cache/cargo \
    if [ -n "$PROFILE_FROM" ]; then rustup component add llvm-tools \
    && CARGO_HOME=/var/cache/cargo cargo install corten-cli --version {{version}} --locked --root /usr/local \
    && if ! corten help build | grep -q -e --profile-from; then \
    echo "corten-cli {{version}} has no --profile-from, so PROFILE_FROM would build without a profile: name a corten-cli release that has it where this Dockerfile installs one" >&2; exit 1; fi; fi
COPY . .
# zstd (corten's `compress`) is linked to this build image's libzstd instead of compiled from its
# C sources, the slowest crate in a clean build, so the server needs libzstd.so.1 where it runs:
# debian:trixie-slim below has it. For a runtime image without it (distroless, scratch), remove
# this line.
ENV ZSTD_SYS_USE_PKG_CONFIG=1
# The target directory is a cache of this app's own (`id`; without one, every image built on this
# machine with a /src/target would share it): builds of this app take turns (`locked`) and other
# apps build alongside. The sources are touched first, since cargo goes by file times and a
# checkout older than the last build would get that build's crates. Downloaded crates are one
# cache for every app, mounted as cargo's whole home, where cargo keeps its lock on them, so two
# builds wait for each other only while one fetches crates.
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id={{name}}-target,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && if [ -z "$PROFILE_FROM" ]; then CARGO_HOME=/var/cache/cargo cargo build --release --locked; \
    elif [ -f "$PROFILE_FROM" ]; then CARGO_HOME=/var/cache/cargo corten build --locked --profile-from sh -- "$PROFILE_FROM"; \
    else echo "PROFILE_FROM=$PROFILE_FROM: the app has no such file" >&2; exit 1; fi \
    && cp target/release/{{name}} /server

FROM debian:trixie-slim
# jemalloc, preloaded, gives back memory a burst of connections took: eight floods of unfinished
# request heads left 329 to 354 MiB with glibc's allocator and about 10 MiB with these settings
# (three runs each). Its background thread returns memory while the app is idle; a 512 KiB thread
# cache keeps brotli's buffers between responses for a page up to about 200 KB, which otherwise
# fault in new pages on every brotli response. The cache keeps what its threads used: 3 to 5 MiB a
# CPU at rest after responses of hundreds of KB, and by jemalloc's rule at most 57 MiB a thread
# (https://github.com/corten-run/corten/blob/main/docs/design.md#choice-jemalloc-image).
# Remove these three lines to run on glibc's allocator.
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:524288
WORKDIR /app
COPY --from=build /server /app/server
# Behind a domain, add the names the app is served under (HOSTS=shop.example): any other Host
# gets 421, so a DNS-rebound page cannot use the app. localhost and IP addresses always answer.
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# The server runs as an unprivileged user, by number so a cluster that requires non-root
# containers (Kubernetes' restricted policy) can tell it is not root, and not 65534 (nobody),
# which other services share: it listens on 8080 and writes no file, and /app/server stays
# root's, so it cannot replace itself. An app that writes files gives that user a directory
# (`RUN mkdir /app/data && chown 10001:10001 /app/data` before this line); a bind mount needs a
# host directory 10001 owns, and a Kubernetes volume `securityContext.fsGroup: 10001`.
USER 10001:10001
CMD ["/app/server"]
