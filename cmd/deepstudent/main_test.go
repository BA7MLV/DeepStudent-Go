package main

import (
	"net"
	"net/http"
	"testing"
	"time"
)

func TestShutdownDesktopHTTPWaitsForServe(t *testing.T) {
	serveDone := make(chan error, 1)
	go func() {
		time.Sleep(20 * time.Millisecond)
		serveDone <- http.ErrServerClosed
	}()

	started := time.Now()
	shutdownDesktopHTTP(nil, nil, serveDone)
	if elapsed := time.Since(started); elapsed < 15*time.Millisecond {
		t.Fatalf("shutdown returned before Serve completed: %s", elapsed)
	}
}

func TestShutdownDesktopHTTPClosesListenerAndWaitsForServe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.NotFoundHandler()}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()

	shutdownDesktopHTTP(server, listener, serveDone)

	// The helper consumes the Serve result after closing the listener. A fresh
	// connection must therefore fail rather than leave the socket serving.
	conn, dialErr := net.DialTimeout("tcp", listener.Addr().String(), 100*time.Millisecond)
	if conn != nil {
		_ = conn.Close()
	}
	if dialErr == nil {
		t.Fatal("listener remained open after desktop shutdown")
	}
}
