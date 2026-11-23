# perf, for sampling the server process during a load run.
FROM rust:1-trixie AS filt
RUN cargo install rustfilt --root /out
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends linux-perf binutils procps && rm -rf /var/lib/apt/lists/*
COPY --from=filt /out/bin/rustfilt /usr/local/bin/rustfilt
