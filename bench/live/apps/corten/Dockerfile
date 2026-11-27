# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f bench/live/apps/corten/Dockerfile -t cb-live-corten .
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS build
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
# Builds of this app share its target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=bench-live-corten.target,target=/src/bench/live/apps/corten/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cd bench/live/apps/corten && test -f Cargo.toml && cargo build --release && mkdir -p /out && cp target/release/live-corten /out/server

FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["/app/server"]
