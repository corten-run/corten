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
# jemalloc, preloaded, gives back memory a burst took: after eight floods of unfinished request
# heads, glibc's allocator kept 419 MiB and jemalloc 45 MiB (one run each), with no measured cost
# per request (docs/design.md, Choice 23). Remove these two lines to run on glibc's.
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
WORKDIR /app
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
