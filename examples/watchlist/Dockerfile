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
# Every build on this machine shares the target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates. rustfmt is for the workspace's tests: `corten ui diff` lays a copy
# out with it.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    rustup component add rustfmt \
    && find . -name target -prune -o -type f -exec touch {} + \
    && cargo test --release --workspace --all-features && cargo build --release -p watchlist \
    && mkdir -p /out && cp target/release/watchlist /out/server

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
