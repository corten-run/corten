# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f bench/nodelay/app/Dockerfile -t corten-nodelay .
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS build
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
# Sources touched first, since cargo goes by file times and a checkout older than the cache's last
# build would get that build's crates; one build at a time on the cache (`locked`).
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=bench-nodelay-corten.target,target=/src/bench/nodelay/app/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cd bench/nodelay/app && test -f Cargo.toml && cargo build --release && mkdir -p /out && cp target/release/nodelay-corten /out/server

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
