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
# Every build on this machine shares the target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
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
CMD ["/app/server"]
