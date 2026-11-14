# The toolchain alone, which bench/fullstack/build.mjs builds the app with.
FROM golang:1.27.4-alpine AS tools
WORKDIR /src
# The templ CLI at the same version as the templ module in go.mod; it writes the *_templ.go files.
RUN go install github.com/a-h/templ/cmd/templ@v0.3.1118

FROM tools AS build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN templ generate && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/itempage .

# Debian, as the other apps: cold-start.mjs reads `date +%s%N`, which Alpine's busybox lacks.
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /out/itempage ./
COPY static ./static
ADD --chmod=644 --checksum=sha256:a0abb04f2f45a1f89d1d4844023245537e5e6014c87b144553e0607b4cc32130 https://unpkg.com/htmx.org@4.0.1/dist/htmx.min.js static/htmx.min.js
# Public assets must remain readable/traversable after a private-umask checkout.
RUN chmod -R a+rX /app/static
ENV GIN_MODE=release PORT=8080
EXPOSE 8080
USER nobody
ENTRYPOINT ["/app/itempage"]
