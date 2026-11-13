# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f examples/card-market/Dockerfile -t corten-card-market .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# zstd (corten's `compress`) is linked to this build image's libzstd instead of compiled from its
# C sources, the slowest crate in a clean build, so the server needs libzstd.so.1 where it runs:
# debian:bookworm-slim below has it. For a runtime image without it (distroless, scratch), remove
# this line.
ENV ZSTD_SYS_USE_PKG_CONFIG=1
# The workspace's target directory is one cache for the examples (`id`; without one, every image
# built on this machine with a /src/target would share it): they take turns (`locked`), each
# building on the crates the last one compiled, and other apps build alongside. The sources are
# touched first, since cargo goes by file times and a checkout older than the last build would get
# that build's crates. Downloaded crates are a cache of the examples' own too: cargo's lock on them
# is in its home, not in `registry`, so two builds sharing one `registry` could unpack the same
# crate at once, and the examples take turns on theirs as on the target.
RUN --mount=type=cache,id=corten-examples.registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=corten-examples.target,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release -p card-market && mkdir -p /out && cp target/release/card-market /out/server

FROM debian:bookworm-slim
# jemalloc, preloaded, with its background thread and a 64 KiB thread cache, gives back memory a
# burst took (eight floods of unfinished heads: 406 to 455 MiB left on glibc's allocator, 13 to 16
# MiB here) and keeps brotli's buffers between responses (docs/design.md#choice-jemalloc-image).
# Remove these three lines to run on glibc's.
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:65536
WORKDIR /app
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# Not root, by number (the template's Dockerfile says why).
USER 10001:10001
CMD ["/app/server"]
