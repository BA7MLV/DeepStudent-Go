package main

import (
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"
)

func TestDesktopWebURLCarriesRuntimeAPI(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	defer listener.Close()
	parsed, err := url.Parse(desktopWebURL(listener))
	if err != nil { t.Fatal(err) }
	want := nativeRuntimeBaseURL(listener) + "/api/v1"
	if got := parsed.Query().Get("runtime"); got != want { t.Fatalf("runtime query = %q, want %q", got, want) }
}

func TestShutdownDesktopHTTPWaitsForServe(t *testing.T) {
	serveDone := make(chan error, 1)
	go func() { time.Sleep(20 * time.Millisecond); serveDone <- http.ErrServerClosed }()
	started := time.Now()
	shutdownDesktopHTTP(nil, nil, serveDone)
	if elapsed := time.Since(started); elapsed < 15*time.Millisecond { t.Fatalf("shutdown returned before Serve completed: %s", elapsed) }
}

func TestShutdownDesktopHTTPClosesListenerAndWaitsForServe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil { t.Fatal(err) }
	server := &http.Server{Handler: http.NotFoundHandler()}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	shutdownDesktopHTTP(server, listener, serveDone)
	conn, dialErr := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond)
	if conn != nil { _ = conn.Close() }
	if dialErr == nil { t.Fatal("listener remained open after desktop shutdown") }
}
