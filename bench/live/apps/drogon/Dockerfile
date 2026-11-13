# syntax=docker/dockerfile:1
FROM debian:trixie-20261027 AS tools
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

FROM debian:trixie-20261027-slim
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
