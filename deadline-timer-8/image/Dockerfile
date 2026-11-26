FROM rust:1-trixie
RUN apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q valgrind libjemalloc2 pkg-config libzstd-dev python3 util-linux binutils && rm -rf /var/lib/apt/lists/*
