# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS tools
RUN rustup target add wasm32-unknown-unknown
RUN curl --proto '=https' --tlsv1.2 -LsSf https://github.com/leptos-rs/cargo-leptos/releases/download/v0.3.11/cargo-leptos-installer.sh | sh

FROM tools AS build
WORKDIR /src
COPY . .
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=live-parity-leptos,target=/src/target,sharing=locked \
    find src public -type f -exec touch {} + \
    && cargo leptos build --release --cargo-locked \
    && mkdir -p /out && cp target/release/live-parity-leptos /out/server && cp -r target/site /out/site

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/ /app/
ENV LEPTOS_OUTPUT_NAME=live_parity LEPTOS_SITE_ROOT=site LEPTOS_SITE_PKG_DIR=pkg LEPTOS_SITE_ADDR=0.0.0.0:8080 LEPTOS_ENV=PROD
USER 65534:65534
EXPOSE 8080
CMD ["/app/server"]
