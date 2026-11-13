# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f examples/corten-site/Dockerfile -t corten-site .
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# The commit the site says it was built from. Without it the build asks git, which answers in a
# clone and not in a worktree's copy, where the site says "unknown".
ARG CORTEN_SITE_HEAT=
ENV CORTEN_SITE_HEAT=$CORTEN_SITE_HEAT
# The workspace's target directory is one cache for the examples (`id`; without one, every image
# built on this machine with a /src/target would share it): they take turns (`locked`), each
# building on the crates the last one compiled, and other apps build alongside. The sources are
# touched first, since cargo goes by file times and a checkout older than the last build would get
# that build's crates. Since the examples take turns, no two of them write the crate cache at once.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,id=corten-examples-target,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release -p corten-site \
    && mkdir -p /out && cp target/release/corten-site /out/server

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/server /app/server
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
# Not root, by number (the template's Dockerfile says why).
USER 10001:10001
CMD ["/app/server"]
