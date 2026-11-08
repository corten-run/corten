# syntax=docker/dockerfile:1
# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM debian:trixie-20261027 AS tools
# Drogon's build dependencies, as its install guide lists them for Debian.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ cmake make git \
        libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libicu-dev \
    && rm -rf /var/lib/apt/lists/*

FROM tools AS build
# Drogon from its tagged release (trantor at the commit the release pins), a Release build.
RUN git clone --quiet --depth 1 --branch v1.9.14 --recurse-submodules --shallow-submodules \
        https://github.com/drogonframework/drogon /drogon \
    && test "$(git -C /drogon rev-parse HEAD)" = 3aae769cc405cf5abb9d477675c6430924f02c7c \
    && cmake -S /drogon -B /drogon/build -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_EXAMPLES=OFF -DBUILD_ORM=OFF -DBUILD_TESTING=OFF \
    && cmake --build /drogon/build -j"$(nproc)" && cmake --install /drogon/build \
    && rm -rf /drogon
WORKDIR /src
COPY . .
ADD --checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js static/htmx.min.js
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j"$(nproc)" \
    && mkdir -p /out && cp build/server /out/server && cp -r static /out/static \
    && chmod 644 /out/static/*

FROM debian:trixie-20261027-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends libjsoncpp26 libssl3t64 libuuid1 zlib1g libicu76 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The server serves static/ from its working directory.
COPY --from=build /out/ /app/
ENV PORT=8080
EXPOSE 8080
CMD ["/app/server"]
