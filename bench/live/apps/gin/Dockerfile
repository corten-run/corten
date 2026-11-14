FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -mod=readonly -p 2 -trimpath -o /server .
FROM debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
WORKDIR /app
COPY --from=build /server .
COPY client.js index.html .
ENV GIN_MODE=release
USER nobody
CMD ["./server"]
