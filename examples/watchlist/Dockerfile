# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f examples/watchlist/Dockerfile -t corten-watchlist .
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
# The workspace's tests run in release in CI's `rust-release` job and in CONTRIBUTING.md's first
# check, not here.
RUN --mount=type=cache,id=corten-examples.registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=corten-examples.target,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release -p watchlist \
    && mkdir -p /out && cp target/release/watchlist /out/server

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# Not root, by number (the template's Dockerfile says why).
USER 10001:10001
CMD ["/app/server"]
