# syntax=docker/dockerfile:1
# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS tools
# The Topcoat CLI bundles the assets the binary declares (stylesheets, the runtime's script).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install topcoat-cli --version =0.12.1 --locked

FROM tools AS build
WORKDIR /src
COPY . .
# Every build on this machine shares the target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release --locked && topcoat asset bundle --release \
    && mkdir -p /out && cp target/release/item-page-topcoat /out/server && cp -r target/release/assets /out/assets

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
WORKDIR /app
# The bundle sits next to the binary, where `AssetBundle::load` looks for it.
COPY --from=build /out/ /app/
ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
CMD ["/app/server"]
