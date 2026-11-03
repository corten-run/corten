FROM golang:1.27.3-alpine AS build
WORKDIR /src
# The templ CLI at the same version as the templ module in go.mod; it writes the *_templ.go files.
RUN go install github.com/a-h/templ/cmd/templ@v0.3.1100
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN templ generate && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/itempage .

FROM alpine:3.24
WORKDIR /app
COPY --from=build /out/itempage ./
COPY static ./static
ADD --chmod=644 --checksum=sha256:d6fdc75f204e6bdefa99b69bf1e6d4ac69b8a364f77929f45c13476b4000f717 https://unpkg.com/htmx.org@2.0.11/dist/htmx.min.js static/htmx.min.js
ENV GIN_MODE=release PORT=8080
EXPOSE 8080
USER nobody
ENTRYPOINT ["/app/itempage"]
