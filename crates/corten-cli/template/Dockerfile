# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# zstd (corten's `compress`) is linked to this build image's libzstd instead of compiled from its
# C sources, the slowest crate in a clean build, so the server needs libzstd.so.1 where it runs:
# debian:bookworm-slim below has it. For a runtime image without it (distroless, scratch), remove
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
    && CARGO_HOME=/var/cache/cargo cargo build --release && cp target/release/{{name}} /server

FROM debian:bookworm-slim
# jemalloc, preloaded, gives back memory a burst of connections took: eight floods of unfinished
# request heads left 406 to 455 MiB with glibc's allocator and 13 to 16 MiB with these settings
# (three runs each). Its background thread returns memory while the app is idle; a 64 KiB thread
# cache keeps a compressor's buffers, which otherwise fault in new pages on every brotli response
# (https://github.com/corten-run/corten/blob/main/docs/design.md#choice-jemalloc-image). Remove
# these three lines to run on glibc's allocator.
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:65536
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
