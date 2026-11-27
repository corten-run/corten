# syntax=docker/dockerfile:1
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS tools
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/var/cache/cargo \
    CARGO_HOME=/var/cache/cargo cargo install cargo-leptos --version =0.3.12 --locked --root /usr/local/cargo

FROM tools AS build
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=live-parity-leptos,target=/src/target,sharing=locked \
    find src public -type f -exec touch {} + \
    && cargo leptos build --release --cargo-locked \
    && mkdir -p /out && cp target/release/live-parity-leptos /out/server && cp -r target/site /out/site

FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
WORKDIR /app
COPY --from=build /out/ /app/
ENV LEPTOS_OUTPUT_NAME=live_parity LEPTOS_SITE_ROOT=site LEPTOS_SITE_PKG_DIR=pkg LEPTOS_SITE_ADDR=0.0.0.0:8080 LEPTOS_ENV=PROD
USER 65534:65534
EXPOSE 8080
CMD ["/app/server"]
