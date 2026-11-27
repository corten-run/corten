FROM golang:1.27.4-alpine@sha256:0a5f7fe796599ff487605987432e7619ae45beeb2fba4c2ce0b907879932aebf AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -mod=readonly -p 2 -trimpath -o /server .
FROM debian:trixie-20261123-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
WORKDIR /app
COPY --from=build /server .
COPY client.js index.html .
ENV GIN_MODE=release
USER nobody
CMD ["./server"]
