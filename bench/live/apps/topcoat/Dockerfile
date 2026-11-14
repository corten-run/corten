# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS tools
ENV CARGO_BUILD_JOBS=2
RUN --mount=type=cache,target=/var/cache/cargo \
    CARGO_HOME=/var/cache/cargo cargo install topcoat-cli --version 0.12.1 --locked --root /usr/local/cargo

FROM tools AS build
WORKDIR /src
COPY . .
ENV CARGO_HOME=/var/cache/cargo
RUN --mount=type=cache,target=/var/cache/cargo \
    --mount=type=cache,id=live-parity-topcoat,target=/src/target,sharing=locked \
    find src static -type f -exec touch {} + \
    && cargo build --release --locked && topcoat asset bundle --release \
    && mkdir -p /out && cp target/release/live-parity-topcoat /out/server && cp -r target/release/assets /out/assets

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
WORKDIR /app
COPY --from=build /out/ /app/
ENV HOST=0.0.0.0 PORT=8080
USER 65534:65534
EXPOSE 8080
CMD ["/app/server"]
