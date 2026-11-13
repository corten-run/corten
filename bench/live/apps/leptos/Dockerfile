# syntax=docker/dockerfile:1
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS tools
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install cargo-leptos --version =0.3.12 --locked

FROM tools AS build
WORKDIR /src
COPY . .
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=live-parity-leptos,target=/src/target,sharing=locked \
    find src public -type f -exec touch {} + \
    && cargo leptos build --release --cargo-locked \
    && mkdir -p /out && cp target/release/live-parity-leptos /out/server && cp -r target/site /out/site

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
WORKDIR /app
COPY --from=build /out/ /app/
ENV LEPTOS_OUTPUT_NAME=live_parity LEPTOS_SITE_ROOT=site LEPTOS_SITE_PKG_DIR=pkg LEPTOS_SITE_ADDR=0.0.0.0:8080 LEPTOS_ENV=PROD
USER 65534:65534
EXPOSE 8080
CMD ["/app/server"]
