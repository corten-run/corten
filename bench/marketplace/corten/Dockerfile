# The root context supplies the same local framework as the other Corten benchmarks.
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libzstd-dev && rm -rf /var/lib/apt/lists/*
ENV ZSTD_SYS_USE_PKG_CONFIG=1
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=bench-marketplace-corten.target,target=/src/bench/marketplace/corten/target,sharing=locked \
    find crates bench/marketplace/corten -name target -prune -o -type f -exec touch {} + \
    && cargo build --manifest-path bench/marketplace/corten/Cargo.toml --release --locked \
    && cp bench/marketplace/corten/target/release/marketplace-corten /server

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update && apt-get install -y --no-install-recommends libzstd1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /server /server
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["/server"]
