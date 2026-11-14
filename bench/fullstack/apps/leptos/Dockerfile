# syntax=docker/dockerfile:1
# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS tools
RUN rustup target add wasm32-unknown-unknown
RUN --mount=type=cache,target=/var/cache/cargo \
    CARGO_HOME=/var/cache/cargo cargo install cargo-leptos --version =0.3.12 --locked --root /usr/local/cargo

FROM tools AS build
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
# Builds of this app share its target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=bench-fullstack-leptos.target,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo leptos build --release --cargo-locked && mkdir -p /out && cp target/release/item-page-leptos /out/server && cp -r target/site /out/site

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/site /app/site
ENV LEPTOS_OUTPUT_NAME=item_page \
    LEPTOS_SITE_ROOT=site \
    LEPTOS_SITE_PKG_DIR=pkg \
    LEPTOS_SITE_ADDR=0.0.0.0:8080 \
    LEPTOS_RELOAD_PORT=3001 \
    LEPTOS_ENV=PROD
EXPOSE 8080
CMD ["/app/server"]
