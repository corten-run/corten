# syntax=docker/dockerfile:1
FROM debian:trixie-20261104@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6 AS tools
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates g++ cmake make git \
        libjsoncpp-dev uuid-dev zlib1g-dev libssl-dev libicu-dev \
    && rm -rf /var/lib/apt/lists/*

FROM tools AS sdk
RUN git clone --quiet --depth 1 --branch v1.9.14 --recurse-submodules --shallow-submodules \
        https://github.com/drogonframework/drogon /drogon \
    && test "$(git -C /drogon rev-parse HEAD)" = 3aae769cc405cf5abb9d477675c6430924f02c7c \
    && cmake -S /drogon -B /drogon/build -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_EXAMPLES=OFF -DBUILD_ORM=OFF -DBUILD_TESTING=OFF \
    && cmake --build /drogon/build -j"$(nproc)" && cmake --install /drogon/build \
    && rm -rf /drogon

FROM sdk AS build
WORKDIR /src
COPY CMakeLists.txt ./
COPY src/ src/
COPY test/feed_test.cc test/feed_test.cc
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j2 && ctest --test-dir build --output-on-failure

FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update \
    && apt-get install -y --no-install-recommends libjsoncpp26 libssl3t64 libuuid1 zlib1g libicu76 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home live \
    && mkdir -p /app/uploads && chown 10001 /app/uploads
WORKDIR /app
COPY --from=build /src/build/server /app/server
COPY static/ /app/static/
USER 10001
ENV PORT=8080
EXPOSE 8080
CMD ["/app/server"]
