# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f examples/auction-room/Dockerfile -t corten-auction-room .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# zstd (corten's `compress`) is linked to this build image's libzstd instead of compiled from its
# C sources, the slowest crate in a clean build, so the server needs libzstd.so.1 where it runs:
# debian:bookworm-slim below has it. For a runtime image without it (distroless, scratch), remove
# this line.
ENV ZSTD_SYS_USE_PKG_CONFIG=1
# Every build on this machine shares the target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release -p auction-room \
    && mkdir -p /out && cp target/release/auction-room /out/server

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/server /app/server
# The database is a file in /app/data, which the server's user owns: mount a volume there to keep
# it. A new Docker volume takes this owner; a bind mount or a Kubernetes volume needs
# `fsGroup: 10001` or a directory 10001 owns, and a volume an earlier image wrote as root needs
# `docker run --rm -u 0 -v <volume>:/app/data --entrypoint chown <image> -R 10001:10001 /app/data`.
RUN mkdir -p /app/data && chown 10001:10001 /app/data
ENV HOST=0.0.0.0 PORT=8080 DATABASE_URL=sqlite:/app/data/auction.db?mode=rwc
EXPOSE 8080
# Not root, by number (the template's Dockerfile says why).
USER 10001:10001
CMD ["/app/server"]