FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY go.* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -mod=readonly -p 2 -trimpath -o /server .
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=build /server .
COPY client.js index.html .
ENV GIN_MODE=release
USER nobody
CMD ["./server"]
