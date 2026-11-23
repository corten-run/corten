# The root context supplies the same local framework as the other Corten benchmarks.
FROM rust:1-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libzstd-dev && rm -rf /var/lib/apt/lists/*
ENV ZSTD_SYS_USE_PKG_CONFIG=1
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=bench-httparena-corten.target,target=/src/bench/httparena/corten/target,sharing=locked \
    find crates bench/httparena/corten -name target -prune -o -type f -exec touch {} + \
    && cargo build --manifest-path bench/httparena/corten/Cargo.toml --release \
    && cp bench/httparena/corten/target/release/httparena-corten /server

# The image `corten new` writes: jemalloc preloaded with its background thread and a 64 KiB
# thread cache (docs/guide/app.md).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libzstd1 libjemalloc2 && rm -rf /var/lib/apt/lists/*
ENV LD_PRELOAD=libjemalloc.so.2
ENV MALLOC_CONF=background_thread:true,tcache_max:65536
COPY --from=build /server /server
ENV HOST=0.0.0.0
CMD ["/server"]
