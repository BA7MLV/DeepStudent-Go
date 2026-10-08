# syntax=docker/dockerfile:1
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/deepstudent-server ./cmd/server \
    && mkdir -p /data \
    && chown 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/deepstudent-server /app/deepstudent-server
# Distroless runs as UID 65532. Copy the pre-created data directory so an
# initially empty named volume inherits write permission for the non-root user.
COPY --from=build --chown=65532:65532 /data /data
VOLUME ["/data"]
ENV DEEPSTUDENT_DB_PATH=/data/deepstudent.db \
    DEEPSTUDENT_BLOB_ROOT=/data/blobs \
    DEEPSTUDENT_HTTP_ADDR=127.0.0.1:8080
EXPOSE 8080
ENTRYPOINT ["/app/deepstudent-server"]
