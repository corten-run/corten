# syntax=docker/dockerfile:1
# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM rust:1-bookworm AS tools
# The Topcoat CLI bundles the assets the binary declares (stylesheets, the runtime's script).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install topcoat-cli --version 0.11.0 --locked

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

FROM debian:bookworm-slim
WORKDIR /app
# The bundle sits next to the binary, where `AssetBundle::load` looks for it.
COPY --from=build /out/ /app/
ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080
CMD ["/app/server"]