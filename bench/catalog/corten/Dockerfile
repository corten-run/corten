# The root context supplies the same local framework as the other Corten benchmarks.
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libzstd-dev && rm -rf /var/lib/apt/lists/*
ENV ZSTD_SYS_USE_PKG_CONFIG=1
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/bench/catalog/corten/target,sharing=locked \
    find crates bench/catalog/corten -name target -prune -o -type f -exec touch {} + \
    && cargo build --manifest-path bench/catalog/corten/Cargo.toml --release --locked \
    && cp bench/catalog/corten/target/release/catalog-corten /server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libzstd1 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /server /server
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["/server"]
