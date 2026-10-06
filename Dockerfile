# syntax=docker/dockerfile:1
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/deepstudent-server ./cmd/server \
	&& CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/deepstudent-healthcheck ./cmd/healthcheck \
	&& mkdir -p /data \
	&& chown 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/deepstudent-server /app/deepstudent-server
COPY --from=build /out/deepstudent-healthcheck /app/deepstudent-healthcheck
# Distroless runs as UID 65532. Copy the pre-created data directory so an
# initially empty named volume inherits write permission for the non-root user.
COPY --from=build --chown=65532:65532 /data /data
VOLUME ["/data"]
ENV DEEPSTUDENT_DB_PATH=/data/deepstudent.db \
    DEEPSTUDENT_BLOB_ROOT=/data/blobs \
    DEEPSTUDENT_HTTP_ADDR=0.0.0.0:8080 \
    DEEPSTUDENT_HEALTHCHECK_URL=http://127.0.0.1:8080/readyz \
    DEEPSTUDENT_PI_ENDPOINT= \
    DEEPSTUDENT_PI_SKIP_START=0
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 CMD ["/app/deepstudent-healthcheck"]
ENTRYPOINT ["/app/deepstudent-server"]
