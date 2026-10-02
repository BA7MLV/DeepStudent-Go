# syntax=docker/dockerfile:1
FROM golang:1.27 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/deepstudent-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/deepstudent-server /app/deepstudent-server
VOLUME ["/data"]
ENV DEEPSTUDENT_DB_PATH=/data/deepstudent.db \
    DEEPSTUDENT_HTTP_ADDR=127.0.0.1:8080
EXPOSE 8080
ENTRYPOINT ["/app/deepstudent-server"]
