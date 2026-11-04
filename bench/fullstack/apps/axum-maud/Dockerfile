# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
WORKDIR /src
COPY . .
# Every build on this machine shares the target cache: one at a time (`locked`), and with the
# sources touched first, since cargo goes by file times and a checkout older than the last build
# would get that build's crates.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target,sharing=locked \
    find . -name target -prune -o -type f -exec touch {} + \
    && cargo build --release --locked && mkdir -p /out && cp target/release/item-page-axum-maud /out/server

FROM debian:bookworm-slim
WORKDIR /app
COPY static /app/static
ADD --checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js /app/static/htmx.min.js
COPY --from=build /out/server /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["/app/server"]
