# syntax=docker/dockerfile:1
FROM rust:1.100.0-trixie@sha256:e19840879045c951c905d0eaa9887f3439c62000e429963371b376bac8d38c31 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
ENV CARGO_HOME=/var/cache/cargo
RUN --mount=type=cache,target=/var/cache/cargo cargo build --release --locked

FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
WORKDIR /app
COPY static static
COPY --from=build /src/target/release/bench-proa /app/server
ENV PORT=8080
EXPOSE 8080
CMD ["/app/server"]
