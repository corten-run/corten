# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Sources touched first, since cargo goes by file times and a checkout older than the cache's last
# build would get that build's crates; one build at a time on the cache (`locked`).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/bench/nodelay/app/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cd bench/nodelay/app && test -f Cargo.toml && cargo build --release && mkdir -p /out && cp target/release/nodelay-corten /out/server

FROM debian:bookworm-slim
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
